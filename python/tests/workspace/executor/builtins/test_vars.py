from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.vars import (handle_env, handle_exit,
                                                     handle_read,
                                                     handle_return,
                                                     handle_shift,
                                                     handle_whoami)
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session.session import Session


def make_session() -> Session:
    return Session(session_id="s1")


def _unused_execute_fn():
    raise AssertionError("execute_fn should not be called")


@pytest.mark.asyncio
async def test_env_prints_environment_in_insertion_order():
    session = make_session()
    session.env["ZZZ"] = "1"
    session.env["AAA"] = "2"
    out, io, _ = await handle_env(_unused_execute_fn, [], session)
    assert io.exit_code == 0
    assert await materialize(out) == b"ZZZ=1\nAAA=2\n"


@pytest.mark.asyncio
async def test_env_ignore_environment_and_null_terminator():
    session = make_session()
    session.env["KEEP"] = "x"
    out, _, _ = await handle_env(_unused_execute_fn,
                                 ["-i", "-0", "A=1", "B=2"], session)
    assert await materialize(out) == b"A=1\x00B=2\x00"


@pytest.mark.asyncio
async def test_env_unset_removes_variable():
    session = make_session()
    session.env["DROP"] = "1"
    session.env["KEEP"] = "2"
    out, _, _ = await handle_env(_unused_execute_fn, ["-u", "DROP"], session)
    rendered = await materialize(out)
    assert b"DROP=" not in rendered
    assert b"KEEP=2" in rendered


@pytest.mark.asyncio
async def test_env_run_form_forwards_stdin_and_restores_env():
    session = make_session()
    session.env["FOO"] = "original"
    execute_fn = AsyncMock(return_value=IOResult(exit_code=0))
    await handle_env(execute_fn, ["-i", "FOO=temp", "printenv", "FOO"],
                     session,
                     stdin=b"piped\n")
    execute_fn.assert_awaited_once()
    args, kwargs = execute_fn.call_args
    assert args[0] == "printenv FOO"
    assert kwargs["stdin"] == b"piped\n"
    # The session environment is restored after the inner command runs.
    assert session.env == {"FOO": "original"}


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


@pytest.mark.asyncio
async def test_shift_non_numeric_errors_like_bash():
    _, io, _ = await handle_shift(["x"], None, session=make_session())
    assert io.exit_code == 1
    assert (await
            materialize(io.stderr)) == b"shift: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_shift_too_many_arguments():
    _, io, _ = await handle_shift(["1", "2"], None, session=make_session())
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"shift: too many arguments\n"


@pytest.mark.asyncio
async def test_shift_default_one():
    session = make_session()
    session.positional_args = ["a", "b"]
    _, io, _ = await handle_shift([], None, session=session)
    assert io.exit_code == 0
    assert session.positional_args == ["b"]


def make_function_stack() -> CallStack:
    cs = CallStack()
    cs.push([], function_name="f")
    return cs


@pytest.mark.asyncio
async def test_return_non_numeric_raises_2_with_message():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["x"], make_session(), make_function_stack())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"return: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_return_numeric():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["7"], make_session(), make_function_stack())
    assert exc.value.exit_code == 7
    assert exc.value.stderr == b""


@pytest.mark.asyncio
async def test_return_bare_propagates_last_exit_code():
    session = make_session()
    session.last_exit_code = 1
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, make_function_stack())
    assert exc.value.exit_code == 1


@pytest.mark.asyncio
async def test_return_outside_function_fails_without_signal():
    _, io, _ = await handle_return([], make_session(), CallStack())
    assert io.exit_code == 2
    assert b"can only `return'" in io.stderr


@pytest.mark.asyncio
async def test_return_in_source_raises_signal():
    session = make_session()
    session.source_depth = 1
    session.last_exit_code = 0
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, None)
    assert exc.value.exit_code == 0


@pytest.mark.asyncio
async def test_return_too_many_args_fails_without_signal():
    _, io, _ = await handle_return(["1", "2"], make_session(),
                                   make_function_stack())
    assert io.exit_code == 1
    assert io.stderr == b"return: too many arguments\n"


@pytest.mark.asyncio
async def test_exit_numeric_raises_signal():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["3"], make_session())
    assert exc.value.exit_code == 3
    assert exc.value.contained_code == 3


@pytest.mark.asyncio
async def test_exit_no_arg_uses_last_exit_code():
    session = make_session()
    session.last_exit_code = 5
    with pytest.raises(ExitSignal) as exc:
        await handle_exit([], session)
    assert exc.value.exit_code == 5


@pytest.mark.asyncio
async def test_exit_wraps_status_mod_256():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["300"], make_session())
    assert exc.value.exit_code == 44
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["-1"], make_session())
    assert exc.value.exit_code == 255


@pytest.mark.asyncio
async def test_exit_non_numeric_exits_2_with_message():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["abc"], make_session())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"exit: abc: numeric argument required\n"


@pytest.mark.asyncio
async def test_exit_too_many_arguments_does_not_exit():
    _, io, _ = await handle_exit(["1", "2"], make_session())
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"exit: too many arguments\n"


@pytest.mark.asyncio
async def test_read_invalid_option_exits_2():
    _, io, _ = await handle_read(["-q", "v"], make_session(), b"line\n")
    assert io.exit_code == 2
    assert await materialize(io.stderr) == b"read: -q: invalid option\n"


@pytest.mark.asyncio
async def test_read_dash_r_consumed_not_a_variable():
    session = make_session()
    _, io, _ = await handle_read(["-r", "v"], session, b"hello world\n")
    assert io.exit_code == 0
    assert session.env["v"] == "hello world"
    assert "-r" not in session.env


@pytest.mark.asyncio
async def test_read_defaults_to_reply():
    session = make_session()
    _, io, _ = await handle_read([], session, b"hi\n")
    assert io.exit_code == 0
    assert session.env["REPLY"] == "hi"


@pytest.mark.asyncio
async def test_whoami_prints_workspace_user():
    out, io, node = await handle_whoami(Namespace(MagicMock(), user="alice"))
    assert io.exit_code == 0
    assert out == b"alice\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_whoami_errors_without_identity():
    out, io, _ = await handle_whoami(Namespace(MagicMock()))
    assert io.exit_code == 1
    assert out is None
    assert io.stderr == b"whoami: cannot find name for user ID\n"


async def _read_ws() -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data")
    return ws


@pytest.mark.asyncio
async def test_read_replaces_stale_stdin_buffer():
    # A previous read's exhausted herestring buffer must not shadow a
    # new command's stdin.
    ws = await _read_ws()
    await ws.execute("read -r x <<< first")
    io = await ws.execute('read -r y <<< second\necho "y=$y"')
    assert (io.stdout or b"") == b"y=second\n"


@pytest.mark.asyncio
async def test_read_scalar_replaces_array():
    ws = await _read_ws()
    await ws.execute("a=(x y z)")
    io = await ws.execute('read -r a b <<< "one two"\necho "a=$a b=$b"')
    assert (io.stdout or b"") == b"a=one b=two\n"
