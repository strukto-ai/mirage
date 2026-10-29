import pytest

from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.set import handle_set
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var


@pytest.mark.asyncio
async def test_set_double_dash_replaces_the_positional_parameters():
    session = SessionState(session_id="s1")
    out, io, node = await handle_set(["--", "a", "b c"], session)
    assert out is None and io.exit_code == 0 and node.command == "set"
    assert session.positional_args == ["a", "b c"]


@pytest.mark.asyncio
async def test_set_bare_lists_the_variables_sorted():
    session = SessionState(session_id="s1")
    seed_var(session, "ZED", "1")
    seed_var(session, "ALPHA", "2")
    out, io, _ = await handle_set([], session)
    lines = (await materialize(out)).decode().splitlines()
    assert io.exit_code == 0
    assert "ALPHA=2" in lines and "ZED=1" in lines
    assert lines == sorted(lines)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value,listed",
    [
        ("a,b", "a,b"),
        ("", ""),
        ("a b", "'a b'"),
        ("it's", "'it'\\''s'"),
        ("~x", "'~x'"),
        ("x=~y", "'x=~y'"),
        ("x~", "x~"),
        ("#c", "'#c'"),
        ("x#", "x#"),
        (" \t\n", "$' \\t\\n'"),
    ],
)
async def test_set_bare_quotes_a_value_as_bash_does(value, listed):
    session = SessionState(session_id="s1")
    seed_var(session, "V", value)
    out, _, _ = await handle_set([], session)
    lines = (await materialize(out)).decode().split("\n")
    assert f"V={listed}" in lines


@pytest.mark.asyncio
async def test_set_bare_sorts_by_name():
    session = SessionState(session_id="s1")
    seed_var(session, "B2", "1")
    seed_var(session, "B", "2")
    out, _, _ = await handle_set([], session)
    lines = (await materialize(out)).decode().splitlines()
    assert lines.index("B=2") < lines.index("B2=1")


@pytest.mark.asyncio
async def test_set_toggles_a_shell_option_by_letter_and_by_name():
    session = SessionState(session_id="s1")
    _, io, _ = await handle_set(["-e"], session)
    assert io.exit_code == 0 and session.shell_options.get("errexit") is True
    _, io, _ = await handle_set(["+o", "errexit"], session)
    assert io.exit_code == 0 and session.shell_options.get("errexit") is False


@pytest.mark.asyncio
async def test_set_refuses_an_unknown_option_name_with_2():
    session = SessionState(session_id="s1")
    out, io, _ = await handle_set(["-o", "nosuchoption"], session)
    assert out is None and io.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("args", "named"), [(["-z"], "-z"), (["-xz"], "-z"), (["-e", "+%"], "+%")]
)
async def test_a_letter_set_lacks_refuses_the_whole_line(args, named):
    session = SessionState(session_id="s1")
    _, io, node = await handle_set([*args, "a"], session)
    assert node.exit_code == 2
    assert (
        io.stderr
        == (
            f"bash: set: {named}: invalid option\n"
            "set: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] "
            "[arg ...]\n"
        ).encode()
    )
    assert not session.shell_options.get("xtrace")
    assert not session.shell_options.get("errexit")
    assert session.positional_args == []
