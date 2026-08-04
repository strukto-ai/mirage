import pytest

from mirage.commands.cli.types import CLISpec
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.lookup.handle import (handle_type,
                                                              handle_which)
from mirage.workspace.session.session import Session

TREE = CLISpec(name="linear",
               subcommands=(CLISpec(name="issue", fn=lambda: None), ))


class FakeRegistry:

    def __init__(self, commands: set[str], with_cli: bool = False):
        self._commands = commands
        self.clis = CLIRegistry()
        if with_cli:
            self.clis.install("linear", TREE)

    def mount_for_command(self, name: str) -> object | None:
        return object() if name in self._commands else None


def make_session() -> Session:
    return Session(session_id="s1")


def make_registry(with_cli: bool = False) -> FakeRegistry:
    return FakeRegistry({"cat", "grep", "ls", "jq"}, with_cli=with_cli)


def _out(result) -> str:
    out, _io, _node = result
    return out.decode() if out is not None else ""


def test_type_reports_builtin():
    out, io, _ = handle_type(["cd"], make_session(), make_registry())
    assert out.decode() == "cd is a shell builtin\n"
    assert io.exit_code == 0


def test_type_reports_keyword():
    assert _out(handle_type(["if"], make_session(),
                            make_registry())) == "if is a shell keyword\n"


def test_type_a_prints_the_function_under_a_keyword():
    session = make_session()
    session.functions["then"] = []
    assert _out(handle_type(
        ["-a", "then"], session,
        make_registry())) == ("then is a shell keyword\nthen is a function\n")


def test_type_reports_installed_cli():
    assert _out(handle_type(["linear"], make_session(),
                            make_registry(True))) == "linear is a mirage CLI\n"
    assert _out(
        handle_type(["-t", "linear"], make_session(),
                    make_registry(True))) == "cli\n"


def test_type_t_prints_word():
    assert _out(handle_type(["-t", "cd"], make_session(),
                            make_registry())) == "builtin\n"
    assert _out(handle_type(["-t", "if"], make_session(),
                            make_registry())) == "keyword\n"


def test_type_last_of_t_and_p_wins():
    # bash: `type -tp cd` prints a path (empty here), `type -pt cd` the
    # type word.
    assert _out(handle_type(["-tp", "cd"], make_session(),
                            make_registry())) == ""
    assert _out(handle_type(["-pt", "cd"], make_session(),
                            make_registry())) == "builtin\n"
    assert _out(handle_type(["-P", "cd"], make_session(),
                            make_registry())) == ""


def test_type_mount_command_is_builtin():
    assert _out(handle_type(["cat"], make_session(),
                            make_registry())) == "cat is a shell builtin\n"


def test_type_a_prints_every_layer():
    session = make_session()
    session.functions["linear"] = []
    assert _out(handle_type(
        ["-a", "linear"], session, make_registry(True))) == (
            "linear is a function\nlinear is a mirage CLI\n")
    assert _out(handle_type(["-at", "linear"], session,
                            make_registry(True))) == "function\ncli\n"


def test_type_f_skips_functions_without_touching_the_session():
    session = make_session()
    body: list[str] = []
    session.functions["linear"] = body
    assert _out(handle_type(["-f", "linear"], session,
                            make_registry(True))) == "linear is a mirage CLI\n"
    assert session.functions["linear"] is body


def test_type_f_on_a_function_only_name_is_not_found():
    session = make_session()
    session.functions["myfn"] = []
    out, io, _ = handle_type(["-f", "myfn"], session, make_registry())
    assert out is None
    assert io.exit_code == 1


def test_type_not_found_warns_and_exits_1():
    out, io, _ = handle_type(["nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"type: nope: not found\n"


def test_type_t_not_found_is_silent():
    out, io, _ = handle_type(["-t", "nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert not io.stderr


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


@pytest.mark.parametrize("name", ["linear", "cd", "cat"])
def test_which_prints_the_name_for_every_runnable(name: str):
    out, io, _ = handle_which([name], make_session(), make_registry(True))
    assert out.decode() == f"{name}\n"
    assert io.exit_code == 0


def test_which_miss_is_silent_and_exits_1():
    out, io, _ = handle_which(["nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert not io.stderr


def test_which_does_not_resolve_a_keyword():
    out, io, _ = handle_which(["if"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


def test_which_reports_the_layer_under_a_keyword():
    # The keyword is filtered before the winner is picked, so the
    # function below it is what `which` resolves.
    session = make_session()
    session.functions["then"] = []
    out, io, _ = handle_which(["then"], session, make_registry())
    assert out.decode() == "then\n"
    assert io.exit_code == 0


def test_which_all_found_exit_rule():
    out, io, _ = handle_which(["cd", "nope"], make_session(), make_registry())
    assert out.decode() == "cd\n"
    assert io.exit_code == 1


def test_which_no_operands_exits_1():
    out, io, _ = handle_which([], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


def test_which_a_prints_a_line_per_layer():
    session = make_session()
    session.functions["linear"] = []
    out, io, _ = handle_which(["-a", "linear"], session, make_registry(True))
    assert out.decode() == "linear\nlinear\n"
    assert io.exit_code == 0


def test_which_s_reports_through_the_status():
    out, io, _ = handle_which(["-s", "cd"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 0
    assert handle_which(["-s", "nope"], make_session(),
                        make_registry())[1].exit_code == 1


def test_which_invalid_option():
    out, io, _ = handle_which(["-z", "cd"], make_session(), make_registry())
    assert io.exit_code == 2
    assert io.stderr.startswith(b"which: -z: invalid option\n")
