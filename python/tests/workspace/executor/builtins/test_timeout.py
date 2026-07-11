import asyncio

import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.timeout import (handle_timeout,
                                                        parse_duration)
from mirage.workspace.session.session import Session


class FakeShell:

    def __init__(self, delay: float = 0.0, exit_code: int = 0):
        self.lines: list[str] = []
        self.delay = delay
        self.exit_code = exit_code

    async def __call__(self, line: str, session_id: str) -> IOResult:
        self.lines.append(line)
        if self.delay:
            await asyncio.sleep(self.delay)
        return IOResult(stdout=b"done\n", exit_code=self.exit_code)


def make_session() -> Session:
    return Session(session_id="s1")


def test_parse_duration_units():
    assert parse_duration("1") == 1.0
    assert parse_duration("0.5") == 0.5
    assert parse_duration("2s") == 2.0
    assert parse_duration("2m") == 120.0
    assert parse_duration("1h") == 3600.0
    assert parse_duration("1d") == 86400.0
    assert parse_duration(".5") == 0.5


def test_parse_duration_rejects_garbage():
    assert parse_duration("xx") is None
    assert parse_duration("-1") is None
    assert parse_duration("1x") is None
    assert parse_duration("") is None


@pytest.mark.asyncio
async def test_command_finishing_in_time_passes_through():
    shell = FakeShell(exit_code=3)
    stdout, io, _ = await handle_timeout(shell, ["5", "wc", "-l"],
                                         make_session())
    assert shell.lines == ["wc -l"]
    assert io.exit_code == 3
    assert stdout == b"done\n"


@pytest.mark.asyncio
async def test_overrun_exits_124():
    shell = FakeShell(delay=1.0)
    _, io, node = await handle_timeout(shell, ["0.05", "sleep", "1"],
                                       make_session())
    assert io.exit_code == 124
    assert node.exit_code == 124


@pytest.mark.asyncio
async def test_invalid_duration_exits_125():
    shell = FakeShell()
    _, io, _ = await handle_timeout(shell, ["xx", "sleep", "1"],
                                    make_session())
    assert io.exit_code == 125
    assert (await
            materialize(io.stderr)) == b"timeout: invalid time interval 'xx'\n"
    assert shell.lines == []


@pytest.mark.asyncio
async def test_missing_operand_exits_125():
    shell = FakeShell()
    _, io, _ = await handle_timeout(shell, ["5"], make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr) == b"timeout: missing operand\n"


@pytest.mark.asyncio
async def test_signal_option_rejected():
    shell = FakeShell()
    _, io, _ = await handle_timeout(shell, ["-s", "KILL", "1", "sleep", "3"],
                                    make_session())
    assert io.exit_code == 125
    assert (await
            materialize(io.stderr)) == b"timeout: unsupported option -- '-s'\n"


@pytest.mark.asyncio
async def test_quoting_survives_rejoin():
    shell = FakeShell()
    await handle_timeout(shell, ["1", "grep", "a b", "f.txt"], make_session())
    assert shell.lines == ["grep 'a b' f.txt"]
