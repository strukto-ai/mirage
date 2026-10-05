import asyncio

import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.timeout.timeout import (
    handle_timeout,
    parse_duration,
    parse_signal,
    signal_name,
)
from mirage.workspace.session.session import SessionState


class FakeShell:
    def __init__(self, delay: float = 0.0, exit_code: int = 0):
        self.lines: list[str] = []
        self.stdins: list[bytes | None] = []
        self.delay = delay
        self.exit_code = exit_code

    async def __call__(
        self, line: str, session_id: str, stdin: bytes | None = None
    ) -> IOResult:
        self.lines.append(line)
        self.stdins.append(stdin)
        if self.delay:
            await asyncio.sleep(self.delay)
        return IOResult(stdout=b"done\n", exit_code=self.exit_code)


TRY = b"Try 'timeout --help' for more information.\n"


def make_session() -> SessionState:
    return SessionState(session_id="s1")


def test_parse_duration_units():
    assert parse_duration("1") == 1.0
    assert parse_duration("0.5") == 0.5
    assert parse_duration("2s") == 2.0
    assert parse_duration("2m") == 120.0
    assert parse_duration("1h") == 3600.0
    assert parse_duration("1d") == 86400.0
    assert parse_duration(".5") == 0.5


def test_parse_duration_reads_c_floats():
    assert parse_duration("1e-1") == 0.1
    assert parse_duration(".1s") == 0.1
    assert parse_duration(" 0.1") == 0.1
    assert parse_duration("0x1p-3") == 0.125
    assert parse_duration("inf") == float("inf")
    assert parse_duration("infinitys") == float("inf")
    assert parse_duration("-0") == 0


def test_parse_duration_rejects_garbage():
    assert parse_duration("xx") is None
    assert parse_duration("-1") is None
    assert parse_duration("1x") is None
    assert parse_duration("") is None
    assert parse_duration("1ss") is None
    assert parse_duration("1,5") is None
    assert parse_duration("1e") is None
    assert parse_duration("nan") is None


@pytest.mark.parametrize(
    "operand, number",
    [
        ("TERM", 15),
        ("sigint", 2),
        ("Sigterm", 15),
        ("SIG9", 9),
        ("IOT", 6),
        ("EXIT", 0),
        ("0", 0),
        ("143", 15),
        ("256", 0),
        ("265", 9),
        ("319", 63),
        ("32", 32),
        ("RTMIN", 34),
        ("rtmin+1", 35),
        ("RTMIN 2", 36),
        ("RTMIN+30", 64),
        ("SIGRTMAX", 64),
        ("RTMAX-30", 34),
        ("FOO", None),
        ("", None),
        ("65", None),
        ("193", None),
        ("255", None),
        ("0x9", None),
        ("9x", None),
        ("sig65", None),
        ("RTMIN+31", None),
        ("RTMIN+ 2", None),
        ("RTMAX+1", None),
        ("2147483648", None),
    ],
)
def test_parse_signal(operand, number):
    assert parse_signal(operand) == number


@pytest.mark.parametrize(
    "number, name",
    [
        (15, "TERM"),
        (6, "ABRT"),
        (17, "CHLD"),
        (29, "POLL"),
        (0, "EXIT"),
        (32, "32"),
        (34, "RTMIN"),
        (40, "RTMIN+6"),
        (49, "RTMIN+15"),
        (50, "RTMAX-14"),
        (64, "RTMAX"),
    ],
)
def test_signal_name(number, name):
    assert signal_name(number) == name


@pytest.mark.asyncio
async def test_command_finishing_in_time_passes_through():
    shell = FakeShell(exit_code=3)
    stdout, io, _ = await handle_timeout(
        shell, ["5", "wc", "-l"], make_session()
    )
    assert shell.lines == ["wc -l"]
    assert io.exit_code == 3
    assert stdout == b"done\n"


@pytest.mark.asyncio
async def test_overrun_exits_124():
    shell = FakeShell(delay=1.0)
    _, io, node = await handle_timeout(
        shell, ["0.05", "sleep", "1"], make_session()
    )
    assert io.exit_code == 124
    assert node.exit_code == 124


@pytest.mark.asyncio
async def test_invalid_duration_exits_125():
    shell = FakeShell()
    _, io, _ = await handle_timeout(
        shell, ["xx", "sleep", "1"], make_session()
    )
    assert io.exit_code == 125
    assert (
        await materialize(io.stderr)
    ) == b"timeout: invalid time interval 'xx'\n" + TRY
    assert shell.lines == []


@pytest.mark.asyncio
async def test_missing_operand_exits_125():
    shell = FakeShell()
    _, io, _ = await handle_timeout(shell, ["5"], make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr) == TRY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args, message",
    [
        (["-s"], b"timeout: option requires an argument -- 's'\n"),
        (["--signal"], b"timeout: option '--signal' requires an argument\n"),
        (["--si"], b"timeout: option '--signal' requires an argument\n"),
        (
            ["--=x", "1", "true"],
            b"timeout: option '--=x' is ambiguous; possibilities: "
            b"'--foreground' '--kill-after' '--preserve-status' '--signal' "
            b"'--verbose' '--help' '--version'\n",
        ),
        (
            ["--v", "1", "true"],
            b"timeout: option '--v' is ambiguous; "
            b"possibilities: '--verbose' '--version'\n",
        ),
        (
            ["--preserve-status=x", "1", "true"],
            b"timeout: option '--preserve-status' doesn't allow an argument\n",
        ),
        (["-x", "1", "true"], b"timeout: invalid option -- 'x'\n"),
        (["-s", "FOO", "1", "true"], b"timeout: 'FOO': invalid signal\n"),
        (["-k", "x", "1", "true"], b"timeout: invalid time interval 'x'\n"),
    ],
)
async def test_option_refusals_exit_125(args, message):
    shell = FakeShell()
    _, io, _ = await handle_timeout(shell, args, make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr) == message + TRY
    assert shell.lines == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args, code, said",
    [
        (["0.05"], 124, b""),
        (
            ["-v", "0.05"],
            124,
            b"timeout: sending signal TERM to command 'sleep'\n",
        ),
        (["-p", "0.05"], 143, b""),
        (["-p", "-s", "INT", "0.05"], 130, b""),
        (["-s", "KILL", "0.05"], 137, b""),
        (["-p", "-s", "QUIT", "0.05"], 131, b""),
        (["-s", "32", "0.05"], 160, b""),
        (["-f", "-s", "32", "0.05"], 124, b""),
        (["-f", "-p", "-s", "33", "0.05"], 161, b""),
        (
            ["-v", "-s", "CONT", "-k", "0.05", "0.05"],
            137,
            b"timeout: sending signal CONT to command 'sleep'\n"
            b"timeout: sending signal KILL to command 'sleep'\n",
        ),
        (
            ["-v", "-f", "-s", "STOP", "-k", "0.05", "0.05"],
            137,
            b"timeout: sending signal STOP to command 'sleep'\n"
            b"timeout: sending signal KILL to command 'sleep'\n",
        ),
        (
            ["-v", "-s", "CHLD", "-k", "0.05", "0.05"],
            137,
            b"timeout: sending signal CHLD to command 'sleep'\n"
            b"timeout: sending signal KILL to command 'sleep'\n",
        ),
    ],
)
async def test_signal_outcomes(args, code, said):
    shell = FakeShell(delay=1.0)
    _, io, node = await handle_timeout(
        shell, [*args, "sleep", "1"], make_session()
    )
    assert io.exit_code == code
    assert node.exit_code == code
    assert (await materialize(io.stderr) or b"") == said


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args, code",
    [
        (["-s", "CONT"], 124),
        (["-s", "0"], 124),
        (["-s", "TSTP"], 124),
        (["-f", "-s", "CHLD"], 124),
        (["-p", "-s", "CONT"], 3),
    ],
)
async def test_ignored_signals_let_the_command_finish(args, code):
    shell = FakeShell(delay=0.2, exit_code=3)
    stdout, io, _ = await handle_timeout(
        shell, [*args, "0.05", "sh"], make_session()
    )
    assert io.exit_code == code
    assert stdout == b"done\n"


@pytest.mark.asyncio
async def test_stopped_timeout_never_returns():
    shell = FakeShell(delay=0.05)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            handle_timeout(
                shell, ["-s", "STOP", "0.01", "sh"], make_session()
            ),
            timeout=0.3,
        )


@pytest.mark.asyncio
async def test_command_reads_timeouts_stdin():
    shell = FakeShell()
    await handle_timeout(shell, ["1", "cat"], make_session(), b"hi\n")
    assert shell.stdins == [b"hi\n"]


@pytest.mark.asyncio
async def test_quoting_survives_rejoin():
    shell = FakeShell()
    await handle_timeout(shell, ["1", "grep", "a b", "f.txt"], make_session())
    assert shell.lines == ["grep 'a b' f.txt"]


class StreamingShell:
    """A shell whose command prints a line, then never finishes."""

    async def __call__(
        self, line: str, session_id: str, stdin: bytes | None = None
    ) -> IOResult:
        async def forever():
            yield b"first\n"
            await asyncio.sleep(10)
            yield b"never\n"

        return IOResult(stdout=forever())


class ComplainingShell:
    """A shell whose command reports an operand on stderr, then never
    finishes, as ``tail -F missing`` does."""

    async def __call__(
        self, line: str, session_id: str, stdin: bytes | None = None
    ) -> IOResult:
        async def forever():
            await asyncio.sleep(10)
            yield b"never\n"

        return IOResult(
            stdout=forever(), stderr=b"tail: nope: No such file or directory\n"
        )


@pytest.mark.asyncio
async def test_overrun_keeps_the_stderr_the_command_had_produced():
    stdout, io, _ = await handle_timeout(
        ComplainingShell(), ["0.1", "tail", "-F", "nope"], make_session()
    )
    assert io.exit_code == 124
    assert stdout is None
    assert io.stderr == b"tail: nope: No such file or directory\n"


@pytest.mark.asyncio
async def test_overrun_keeps_what_the_command_had_printed():
    stdout, io, _ = await handle_timeout(
        StreamingShell(), ["0.1", "tail", "-f"], make_session()
    )
    assert io.exit_code == 124
    assert stdout == b"first\n"
