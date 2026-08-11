import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.command import handle_command_builtin
from mirage.workspace.session.session import Session


class FakeRegistry:

    def __init__(self, commands: set[str]):
        self._commands = commands
        self.clis = CLIRegistry()

    def mount_for_command(self, name: str) -> object | None:
        return object() if name in self._commands else None


class FakeShell:

    def __init__(self, exit_code: int = 0, stdout: bytes = b""):
        self.lines: list[str] = []
        self.stdins: list[object] = []
        self.exit_code = exit_code
        self.stdout = stdout

    async def __call__(self,
                       line: str,
                       session_id: str,
                       stdin: object = None) -> IOResult:
        self.lines.append(line)
        self.stdins.append(stdin)
        return IOResult(stdout=self.stdout, exit_code=self.exit_code)


def make_session() -> Session:
    return Session(session_id="s1")


def make_registry() -> FakeRegistry:
    return FakeRegistry({"cat", "grep", "ls", "jq"})


@pytest.mark.asyncio
@pytest.mark.parametrize("args,expected", [
    (["-vV", "cd"], b"cd is a shell builtin\n"),
    (["-Vv", "cd"], b"cd\n"),
    (["-pv", "cd"], b"cd\n"),
])
async def test_last_of_v_or_V_wins_and_p_is_inert(args: list[str],
                                                  expected: bytes):
    out, _io, _ = await handle_command_builtin(FakeShell(), args,
                                               make_session(), make_registry())
    assert await materialize(out) == expected


@pytest.mark.asyncio
async def test_a_flag_after_the_target_belongs_to_the_target():
    shell = FakeShell()
    await handle_command_builtin(shell, ["ls", "-l"], make_session(),
                                 make_registry())
    assert shell.lines == ["ls -l"]


@pytest.mark.asyncio
async def test_v_prints_name_no_fake_path():
    out, io, _ = await handle_command_builtin(FakeShell(), ["-v", "cat"],
                                              make_session(), make_registry())
    assert await materialize(out) == b"cat\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_v_not_found_is_silent_rc1():
    out, io, _ = await handle_command_builtin(FakeShell(), ["-v", "nope_xyz"],
                                              make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_v_multi_name_any_found_rc0():
    out, io, _ = await handle_command_builtin(FakeShell(),
                                              ["-v", "ls", "nope_xyz", "cat"],
                                              make_session(), make_registry())
    assert await materialize(out) == b"ls\ncat\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_V_warns_for_a_missing_name_while_exiting_0():
    # bash prints the diagnostic and still exits 0 when another name
    # resolved: the status and the stderr are independent.
    out, io, _ = await handle_command_builtin(FakeShell(),
                                              ["-V", "cd", "nope_xyz"],
                                              make_session(), make_registry())
    assert await materialize(out) == b"cd is a shell builtin\n"
    assert await materialize(io.stderr) == b"command: nope_xyz: not found\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_v_multi_name_none_found_rc1():
    out, io, _ = await handle_command_builtin(FakeShell(),
                                              ["-v", "nope1", "nope2"],
                                              make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_V_verbose_lines():
    out, io, _ = await handle_command_builtin(FakeShell(), ["-V", "cd"],
                                              make_session(), make_registry())
    assert await materialize(out) == b"cd is a shell builtin\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_V_not_found_warns_on_stderr_rc1():
    out, io, _ = await handle_command_builtin(FakeShell(), ["-V", "nope_xyz"],
                                              make_session(), make_registry())
    assert out is None
    assert await materialize(io.stderr) == b"command: nope_xyz: not found\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_invalid_option_rc2_with_usage():
    _, io, _ = await handle_command_builtin(FakeShell(), ["-x", "ls"],
                                            make_session(), make_registry())
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err == (b"command: -x: invalid option\n"
                   b"command: usage: command [-pVv] command [arg ...]\n")


@pytest.mark.asyncio
async def test_no_args_rc0():
    _, io, _ = await handle_command_builtin(FakeShell(), [], make_session(),
                                            make_registry())
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_v_no_name_rc0():
    _, io, _ = await handle_command_builtin(FakeShell(), ["-v"],
                                            make_session(), make_registry())
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_run_mode_joins_and_runs():
    shell = FakeShell(exit_code=0, stdout=b"hello\n")
    out, io, _ = await handle_command_builtin(shell, ["echo", "hello"],
                                              make_session(), make_registry())
    assert shell.lines == ["echo hello"]
    assert io.exit_code == 0
    assert out == b"hello\n"


@pytest.mark.asyncio
async def test_run_mode_shlex_quotes_operands():
    shell = FakeShell()
    await handle_command_builtin(shell, ["echo", "a b", "$x"], make_session(),
                                 make_registry())
    assert shell.lines == ["echo 'a b' '$x'"]


@pytest.mark.asyncio
async def test_run_mode_passes_stdin():
    shell = FakeShell()
    await handle_command_builtin(shell, ["cat"],
                                 make_session(),
                                 make_registry(),
                                 stdin=b"piped\n")
    assert shell.stdins == [b"piped\n"]


@pytest.mark.asyncio
async def test_run_mode_masks_function_then_restores():
    session = make_session()
    body = ["<fn-body>"]
    session.functions["cat"] = body
    seen: dict[str, bool] = {}

    async def shell(line: str,
                    session_id: str,
                    stdin: object = None) -> IOResult:
        seen["masked"] = "cat" not in session.functions
        return IOResult(exit_code=0)

    await handle_command_builtin(shell, ["cat"], session, make_registry())
    assert seen["masked"] is True
    assert session.functions["cat"] is body
