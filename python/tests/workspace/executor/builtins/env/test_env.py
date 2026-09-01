from unittest.mock import AsyncMock

import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.shell.variable import ManagedRef, ShellVar, VarAttr
from mirage.workspace.executor.builtins.env import handle_env
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import seed_var, set_attr


def make_session() -> Session:
    return Session(session_id="s1")


def seed_exported(session: Session, name: str, value: str) -> None:
    """Seed a variable the process-view printers will actually list.

    `env`, `printenv` and `export -p` show exported names only, so a
    test whose subject is ordering or quoting has to mark what it seeds
    or it renders nothing at all. `seed_var` alone makes a correct
    plain shell variable, which those three rightly never print.

    Args:
        session (Session): the session being seeded.
        name (str): variable name.
        value (str): the value to store.
    """
    seed_var(session, name, value)
    set_attr(session, name, VarAttr.EXPORT)


def _unused_execute_fn():
    raise AssertionError("execute_fn should not be called")


@pytest.mark.asyncio
async def test_env_prints_environment_in_insertion_order():
    session = make_session()
    seed_exported(session, "ZZZ", "1")
    seed_exported(session, "AAA", "2")
    out, io, _ = await handle_env(_unused_execute_fn, [], session)
    assert io.exit_code == 0
    # `$PWD` is seeded at construction, so it leads the insertion order.
    assert await materialize(out) == b"PWD=/\nZZZ=1\nAAA=2\n"


@pytest.mark.asyncio
async def test_env_ignore_environment_and_null_terminator():
    session = make_session()
    seed_var(session, "KEEP", "x")
    out, _, _ = await handle_env(_unused_execute_fn,
                                 ["-i", "-0", "A=1", "B=2"], session)
    assert await materialize(out) == b"A=1\x00B=2\x00"


@pytest.mark.asyncio
async def test_env_unset_removes_variable():
    session = make_session()
    seed_exported(session, "DROP", "1")
    seed_exported(session, "KEEP", "2")
    out, _, _ = await handle_env(_unused_execute_fn, ["-u", "DROP"], session)
    rendered = await materialize(out)
    assert b"DROP=" not in rendered
    assert b"KEEP=2" in rendered


@pytest.mark.asyncio
async def test_env_run_form_forwards_stdin_and_restores_env():
    session = make_session()
    seed_var(session, "FOO", "original")
    execute_fn = AsyncMock(return_value=IOResult(exit_code=0))
    await handle_env(execute_fn, ["-i", "FOO=temp", "printenv", "FOO"],
                     session,
                     stdin=b"piped\n")
    execute_fn.assert_awaited_once()
    args, kwargs = execute_fn.call_args
    assert args[0] == "printenv FOO"
    assert kwargs["stdin"] == b"piped\n"
    # The session environment is restored after the inner command runs.
    assert session.env == {"PWD": "/", "FOO": "original"}


@pytest.mark.asyncio
async def test_env_run_form_drops_a_pending_managed_entry():
    # A still-unfetched managed entry is a scalar in waiting, so the
    # swapped scope drops it like any replaced scalar: surviving would
    # let the inner line fetch a name `-i` just cleared.
    session = make_session()
    session.vars["TOKEN"] = ShellVar(None,
                                     frozenset({VarAttr.EXPORT}),
                                     managed=ManagedRef("fake", "r", "TOKEN"))
    inner: dict[str, ShellVar] = {}

    async def execute_fn(command, session_id, stdin=None):
        inner.update(session.vars)
        return IOResult(exit_code=0)

    await handle_env(execute_fn, ["-i", "printenv", "TOKEN"], session)
    assert "TOKEN" not in inner
    assert session.vars["TOKEN"].managed is not None


@pytest.mark.asyncio
async def test_env_lone_dash_implies_ignore_environment():
    session = make_session()
    seed_var(session, "KEEP", "x")
    out, io, _ = await handle_env(_unused_execute_fn, ["-", "A=1"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b"A=1\n"


@pytest.mark.asyncio
async def test_env_null_with_command_rejected():
    _, io, _ = await handle_env(_unused_execute_fn, ["-0", "echo", "hi"],
                                make_session())
    assert io.exit_code == 125
    assert await materialize(
        io.stderr) == (b"env: cannot specify --null (-0) with command\n"
                       b"Try 'env --help' for more information.\n")


@pytest.mark.asyncio
async def test_env_invalid_option_exits_125():
    _, io, _ = await handle_env(_unused_execute_fn, ["-Z"], make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr
                             ) == (b"env: invalid option -- 'Z'\n"
                                   b"Try 'env --help' for more information.\n")


@pytest.mark.asyncio
async def test_env_unrecognized_long_option_exits_125():
    _, io, _ = await handle_env(_unused_execute_fn, ["--bogus"],
                                make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr
                             ) == (b"env: unrecognized option '--bogus'\n"
                                   b"Try 'env --help' for more information.\n")
