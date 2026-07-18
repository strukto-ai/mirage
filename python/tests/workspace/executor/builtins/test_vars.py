from unittest.mock import MagicMock

import pytest

from mirage.io.stream import materialize
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.vars import (handle_exit, handle_read,
                                                     handle_return,
                                                     handle_shift,
                                                     handle_whoami)
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session.session import Session


def make_session() -> Session:
    return Session(session_id="s1")


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


@pytest.mark.asyncio
async def test_return_non_numeric_raises_2_with_message():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["x"])
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"return: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_return_numeric():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["7"])
    assert exc.value.exit_code == 7
    assert exc.value.stderr == b""


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
