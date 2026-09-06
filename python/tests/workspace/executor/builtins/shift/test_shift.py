import pytest

from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.shift import handle_shift
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
async def test_shift_past_the_count_is_a_silent_one():
    session = make_session()
    session.positional_args = ["a", "b"]
    _, io, _ = await handle_shift(["3"], None, session=session)
    assert io.exit_code == 1
    assert io.stderr is None
    assert session.positional_args == ["a", "b"]
    _, io, _ = await handle_shift([], None, session=make_session())
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_shift_negative_count_is_out_of_range():
    _, io, _ = await handle_shift(["-1"], None, session=make_session())
    assert io.exit_code == 1
    assert (await
            materialize(io.stderr)) == b"shift: -1: shift count out of range\n"
