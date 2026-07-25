import pytest

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.command import (_classify, _describe,
                                                        _parse_flags,
                                                        handle_command_builtin,
                                                        handle_type)
from mirage.workspace.session.session import Session


class FakeRegistry:

    def __init__(self, commands: set[str]):
        self._commands = commands

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


def test_parse_flags_last_v_or_V_wins():
    assert _parse_flags(["-v", "ls"]) == ("v", ["ls"], None)
    assert _parse_flags(["-V", "ls"]) == ("V", ["ls"], None)
    assert _parse_flags(["-vV", "ls"]) == ("V", ["ls"], None)
    assert _parse_flags(["-Vv", "ls"]) == ("v", ["ls"], None)


def test_parse_flags_p_is_accepted_but_inert():
    assert _parse_flags(["-p", "ls"]) == (None, ["ls"], None)
    assert _parse_flags(["-pv", "ls"]) == ("v", ["ls"], None)


def test_parse_flags_stops_at_first_operand():
    # A flag after the target name belongs to the target.
    assert _parse_flags(["ls", "-l"]) == (None, ["ls", "-l"], None)
    assert _parse_flags(["-v", "ls", "-l"]) == ("v", ["ls", "-l"], None)


def test_parse_flags_double_dash_ends_options():
    assert _parse_flags(["--", "ls"]) == (None, ["ls"], None)
    assert _parse_flags(["-v", "--", "ls"]) == ("v", ["ls"], None)


def test_parse_flags_invalid_option():
    assert _parse_flags(["-x", "ls"]) == (None, [], "-x")
    assert _parse_flags(["-vx", "ls"]) == (None, [], "-x")


def test_parse_flags_bare_dash_is_operand():
    assert _parse_flags(["-"]) == (None, ["-"], None)


def test_classify_keyword_before_route():
    session = make_session()
    registry = make_registry()
    for kw in ("if", "for", "while", "case", "[[", "]]", "!", "{", "}"):
        assert _classify(kw, session, registry) == "keyword"


def test_classify_shell_builtin_and_mount_are_builtin():
    session = make_session()
    registry = make_registry()
    assert _classify("cd", session, registry) == "builtin"
    assert _classify("echo", session, registry) == "builtin"
    assert _classify("cat", session, registry) == "builtin"
    assert _classify("jq", session, registry) == "builtin"


def test_classify_function_and_not_found():
    session = make_session()
    session.functions["myfn"] = []
    registry = make_registry()
    assert _classify("myfn", session, registry) == "function"
    assert _classify("nope_xyz", session, registry) == "not_found"


def test_describe_lines():
    assert _describe("if", "keyword") == "if is a shell keyword"
    assert _describe("myfn", "function") == "myfn is a function"
    assert _describe("cat", "builtin") == "cat is a shell builtin"


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


def _type_out(result) -> str:
    out, _io, _node = result
    return out.decode() if out is not None else ""


def test_type_reports_builtin():
    out, io, _ = handle_type(["cd"], make_session(), make_registry())
    assert out.decode() == "cd is a shell builtin\n"
    assert io.exit_code == 0


def test_type_reports_keyword():
    assert _type_out(handle_type(["if"], make_session(),
                                 make_registry())) == "if is a shell keyword\n"


def test_type_t_prints_word():
    assert _type_out(handle_type(["-t", "cd"], make_session(),
                                 make_registry())) == "builtin\n"
    assert _type_out(handle_type(["-t", "if"], make_session(),
                                 make_registry())) == "keyword\n"


def test_type_mount_command_is_builtin():
    assert _type_out(
        handle_type(["cat"], make_session(),
                    make_registry())) == "cat is a shell builtin\n"


def test_type_not_found_warns_and_exits_1():
    out, io, _ = handle_type(["nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"type: nope: not found\n"


def test_type_t_not_found_is_silent():
    out, io, _ = handle_type(["-t", "nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b""


def test_type_all_found_exit_rule():
    out, io, _ = handle_type(["cd", "nope"], make_session(), make_registry())
    assert out.decode() == "cd is a shell builtin\n"
    assert io.exit_code == 1


def test_type_path_mode_empty_for_builtin():
    out, io, _ = handle_type(["-p", "cd"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 0


def test_type_invalid_option():
    out, io, _ = handle_type(["-x", "cd"], make_session(), make_registry())
    assert io.exit_code == 2
    assert io.stderr.startswith(b"type: -x: invalid option\n")
