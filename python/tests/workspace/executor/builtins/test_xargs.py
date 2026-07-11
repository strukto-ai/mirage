import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.xargs import handle_xargs
from mirage.workspace.session.session import Session


class FakeShell:

    def __init__(self, exit_codes: list[int] | None = None):
        self.lines: list[str] = []
        self.exit_codes = exit_codes or []

    async def __call__(self, line: str, session_id: str) -> IOResult:
        self.lines.append(line)
        code = (self.exit_codes[len(self.lines) - 1]
                if len(self.lines) <= len(self.exit_codes) else 0)
        return IOResult(stdout=f"ran:{line}\n".encode(), exit_code=code)


def make_session() -> Session:
    return Session(session_id="s1")


@pytest.mark.asyncio
async def test_batches_one_arg_per_run_with_n1():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["-n1", "echo"], make_session(),
                                  b"a b c")
    assert shell.lines == ["echo a", "echo b", "echo c"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_single_run_without_n():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["echo"], make_session(), b"a b c")
    assert shell.lines == ["echo a b c"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_failing_invocation_exits_123_but_continues():
    shell = FakeShell(exit_codes=[1, 0])
    _, io, _ = await handle_xargs(shell, ["-n1", "wc"], make_session(), b"a b")
    assert shell.lines == ["wc a", "wc b"]
    assert io.exit_code == 123


@pytest.mark.asyncio
async def test_command_not_found_stops_with_127():
    shell = FakeShell(exit_codes=[127, 0])
    _, io, _ = await handle_xargs(shell, ["-n1", "nope"], make_session(),
                                  b"a b")
    assert shell.lines == ["nope a"]
    assert io.exit_code == 127


@pytest.mark.asyncio
async def test_no_run_if_empty():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["-r", "echo", "hi"], make_session(),
                                  b"")
    assert shell.lines == []
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_empty_input_without_r_runs_once():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["echo", "hi"], make_session(), b"")
    assert shell.lines == ["echo hi"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_null_delimited_input():
    shell = FakeShell()
    await handle_xargs(shell, ["-0", "echo"], make_session(), b"a b\0c\0")
    assert shell.lines == ["echo 'a b' c"]


@pytest.mark.asyncio
async def test_custom_delimiter():
    shell = FakeShell()
    await handle_xargs(shell, ["-d,", "echo"], make_session(), b"a,b,c")
    assert shell.lines == ["echo a b c"]


@pytest.mark.asyncio
async def test_invalid_option_exits_1():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["-q", "echo"], make_session(), b"x")
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"xargs: invalid option -- 'q'\n"
    assert shell.lines == []


@pytest.mark.asyncio
async def test_unsupported_option_exits_1():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["-I", "{}", "echo"], make_session(),
                                  b"x")
    assert io.exit_code == 1
    assert await materialize(io.stderr
                             ) == b"xargs: unsupported option -- 'I'\n"


@pytest.mark.asyncio
async def test_n_zero_rejected():
    shell = FakeShell()
    _, io, _ = await handle_xargs(shell, ["-n0", "echo"], make_session(), b"x")
    assert io.exit_code == 1
    assert (await
            materialize(io.stderr
                        )) == b"xargs: value 0 for -n option should be >= 1\n"


@pytest.mark.asyncio
async def test_input_words_stay_single_tokens():
    shell = FakeShell()
    await handle_xargs(shell, ["echo"], make_session(), b"don't $(reboot)")
    assert shell.lines == ["echo 'don'\"'\"'t' '$(reboot)'"]
