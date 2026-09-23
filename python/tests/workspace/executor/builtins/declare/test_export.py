import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.stream import materialize
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare import handle_export
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var, session_view, set_attr


def make_session() -> SessionState:
    return SessionState(session_id="s1")


def seed_exported(session: SessionState, name: str, value: str) -> None:
    """Seed a variable the process-view printers will actually list.

    `env`, `printenv` and `export -p` show exported names only, so a
    test whose subject is ordering or quoting has to mark what it seeds
    or it renders nothing at all. `seed_var` alone makes a correct
    plain shell variable, which those three rightly never print.

    Args:
        session (SessionState): the session being seeded.
        name (str): variable name.
        value (str): the value to store.
    """
    seed_var(session, name, value)
    set_attr(session, name, VarAttr.EXPORT)


@pytest.mark.asyncio
async def test_export_p_prints_declare_x():
    session = make_session()
    seed_exported(session, "ZZZ", "1")
    seed_exported(session, "AAA", 'a"b')
    seed_exported(session, "NL", "a\nb")
    seed_exported(session, "DOL", "a$b")
    out, io, _ = await handle_export(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    assert 'declare -x AAA="a\\"b"\n' in text
    assert 'declare -x DOL="a\\$b"\n' in text
    assert "declare -x NL=$'a\\nb'\n" in text
    assert 'declare -x ZZZ="1"\n' in text
    # Sorted by name
    assert text.index("AAA") < text.index("ZZZ")


@pytest.mark.asyncio
async def test_export_bare_prints_like_p():
    session = make_session()
    seed_exported(session, "FOO", "bar")
    out, io, _ = await handle_export([], session)
    assert io.exit_code == 0
    # `$PWD` is exported like any other variable, so bash lists it too.
    assert await materialize(out) == (b'declare -x FOO="bar"\n'
                                      b'declare -x PWD="/"\n')


@pytest.mark.asyncio
async def test_export_invalid_option_exit_2():
    session = make_session()
    _, io, _ = await handle_export(["-z"], session)
    assert io.exit_code == 2
    err = (io.stderr or b"").decode()
    assert "invalid option" in err
    assert "usage: export" in err


@pytest.mark.asyncio
async def test_export_write_requires_a_threaded_view():
    # A write reached without the workspace's gated view is a wiring
    # bug, not a mode: the old fallback built an ungated view here, so
    # `export AWS_SECRET_ACCESS_KEY=x` cleared every pre_session rule.
    session = make_session()
    with pytest.raises(RuntimeError, match="gated session view"):
        await handle_export(["SECRET=x"], session)


@pytest.mark.asyncio
async def test_export_p_with_name_does_not_print():
    session = make_session()
    seed_var(session, "KEEP", "1")
    out, io, _ = await handle_export(["-p", "FOO=bar"],
                                     session,
                                     state=session_view(session))
    assert io.exit_code == 0
    assert out is None
    assert session.env["FOO"] == "bar"


@pytest.mark.asyncio
async def test_export_p_via_workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('export ZEP1=v1; export -p | grep ZEP1')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -x ZEP1="v1"\n'


@pytest.mark.asyncio
async def test_export_invalid_option_via_workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("export -z")
    assert io.exit_code == 2
    assert b"invalid option" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_export_p_quotes_control_characters():
    session = make_session()
    session.vars.clear()
    seed_exported(session, "TAB", "a\tb")
    seed_exported(session, "ESC", "a\x1bb")
    seed_exported(session, "BEL", "a\x07b")
    seed_exported(session, "SOH", "a\x01b")
    seed_exported(session, "DEL", "a\x7fb")
    seed_exported(session, "UTF", "café")
    out, io, _ = await handle_export(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    # GNU bash uses $'...' for any control character, named escapes where
    # it has one and three-digit octal otherwise.
    assert "declare -x TAB=$'a\\tb'\n" in text
    assert "declare -x ESC=$'a\\Eb'\n" in text
    assert "declare -x BEL=$'a\\ab'\n" in text
    assert "declare -x SOH=$'a\\001b'\n" in text
    assert "declare -x DEL=$'a\\177b'\n" in text
    # Printable non-ASCII stays literal, as bash does in a UTF-8 locale.
    assert 'declare -x UTF="café"\n' in text


@pytest.mark.asyncio
async def test_export_p_double_terminator_still_prints():
    session = make_session()
    session.vars.clear()
    seed_exported(session, "FOO", "bar")
    out, io, _ = await handle_export(["-p", "--"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b'declare -x FOO="bar"\n'


@pytest.mark.asyncio
async def test_export_f_lists_no_variables():
    session = make_session()
    seed_var(session, "FOO", "bar")
    out, io, _ = await handle_export(["-f"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b""


@pytest.mark.asyncio
async def test_export_reports_first_invalid_option():
    session = make_session()
    _, io, _ = await handle_export(["-zq"], session)
    assert (io.stderr or b"").startswith(b"bash: export: -z: invalid option")


@pytest.mark.asyncio
async def test_export_p_terminator_via_workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('export ZEP5=v5; export -p -- | grep ZEP5')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -x ZEP5="v5"\n'
