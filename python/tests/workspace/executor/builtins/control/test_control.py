import pytest

from mirage.io import IOResult
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.workspace.executor.builtins.control import (
    handle_colon,
    handle_exit,
    handle_false,
    handle_return,
    handle_true,
)
from mirage.workspace.session.session import SessionState


def make_session() -> SessionState:
    return SessionState(session_id="s1")


def make_function_stack() -> CallStack:
    cs = CallStack()
    cs.push([], function_name="f")
    return cs


@pytest.mark.asyncio
async def test_return_non_numeric_raises_2_with_message():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["x"], make_session(), make_function_stack())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"bash: return: x: numeric argument required\n"


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
    cs = CallStack()
    cs.push([], function_name="source", sourced=True)
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], make_session(), cs)
    assert exc.value.exit_code == 0


@pytest.mark.asyncio
async def test_return_too_many_args_abandons_the_line():
    with pytest.raises(ExitSignal) as exc:
        await handle_return(["1", "2"], make_session(), make_function_stack())
    assert exc.value.exit_code == 1
    assert exc.value.stderr == b"bash: return: too many arguments\n"


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
    assert exc.value.stderr == b"bash: exit: abc: numeric argument required\n"


@pytest.mark.asyncio
async def test_exit_too_many_arguments_abandons_the_line():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["1", "2"], make_session())
    assert exc.value.exit_code == 1
    assert exc.value.stderr == b"bash: exit: too many arguments\n"


@pytest.mark.asyncio
async def test_exit_runs_the_exit_action_in_its_frames():
    session = make_session()
    session.exit_trap = "echo cleanup:$1"
    frames = make_function_stack()
    seen: list[tuple[str, CallStack | None, int]] = []

    async def execute_fn(line: str, **kwargs) -> IOResult:
        seen.append((line, kwargs["call_stack"], session.last_exit_code))
        return IOResult(stdout=b"cleanup\n", stderr=b"warn\n")

    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["abc"], session, execute_fn, None, frames)
    assert seen == [("echo cleanup:$1", frames, 2)]
    assert exc.value.exit_code == 2
    assert exc.value.stdout == b"cleanup\n"
    assert exc.value.stderr == (
        b"bash: exit: abc: numeric argument required\nwarn\n"
    )


@pytest.mark.asyncio
async def test_bare_exit_in_the_action_keeps_the_ending_status():
    session = make_session()
    session.last_exit_code = 0
    session._trap_status = 5
    with pytest.raises(ExitSignal) as exc:
        await handle_exit([], session)
    assert exc.value.exit_code == 5


@pytest.mark.asyncio
async def test_true_false_colon_fixed_status():
    out, io, node = await handle_true()
    assert (out, io.exit_code, node.command, node.exit_code) == (
        None,
        0,
        "true",
        0,
    )
    out, io, node = await handle_colon()
    assert (out, io.exit_code, node.command, node.exit_code) == (
        None,
        0,
        ":",
        0,
    )
    out, io, node = await handle_false()
    assert (out, io.exit_code, node.command, node.exit_code) == (
        None,
        1,
        "false",
        1,
    )
