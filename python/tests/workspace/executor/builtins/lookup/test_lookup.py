import pytest

from mirage.commands.cli.types import CLISpec
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.lookup.lookup import (
    handle_type,
    handle_which,
)
from mirage.workspace.session.session import SessionState

TREE = CLISpec(
    name="linear", subcommands=(CLISpec(name="issue", fn=lambda: None),)
)


class FakeRegistry:
    def __init__(self, commands: set[str], with_cli: bool = False):
        self._commands = commands
        self.runtime_bindings = {}
        self.runtime_unavailable = {}
        self.clis = CLIRegistry()
        if with_cli:
            self.clis.install("linear", TREE)

    def mount_for_command(self, name: str) -> object | None:
        return object() if name in self._commands else None


def make_session() -> SessionState:
    return SessionState(session_id="s1")


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
    assert (
        _out(handle_type(["if"], make_session(), make_registry()))
        == "if is a shell keyword\n"
    )


def test_type_a_prints_the_function_under_a_keyword():
    session = make_session()
    session.functions["then"] = "then() { echo x; }"
    assert _out(handle_type(["-a", "then"], session, make_registry())) == (
        "then is a shell keyword\nthen is a function\n"
        "function then () \n{ \n    echo x\n}\n"
    )


def test_type_reports_installed_cli_by_its_file():
    assert (
        _out(handle_type(["linear"], make_session(), make_registry(True)))
        == "linear is /usr/bin/linear\n"
    )
    assert (
        _out(
            handle_type(["-t", "linear"], make_session(), make_registry(True))
        )
        == "file\n"
    )


def test_type_t_prints_word():
    assert (
        _out(handle_type(["-t", "cd"], make_session(), make_registry()))
        == "builtin\n"
    )
    assert (
        _out(handle_type(["-t", "if"], make_session(), make_registry()))
        == "keyword\n"
    )


def test_type_last_of_t_and_p_wins():
    # bash: `type -tp cd` prints a path (empty here), `type -pt cd` the
    # type word.
    assert (
        _out(handle_type(["-tp", "cd"], make_session(), make_registry())) == ""
    )
    assert (
        _out(handle_type(["-pt", "cd"], make_session(), make_registry()))
        == "builtin\n"
    )
    assert (
        _out(handle_type(["-P", "cd"], make_session(), make_registry())) == ""
    )


def test_type_mount_command_is_its_file():
    assert (
        _out(handle_type(["cat"], make_session(), make_registry()))
        == "cat is /usr/bin/cat\n"
    )


def test_type_p_prints_a_programs_file_and_P_searches_past_a_builtin():
    # bash 5.2: -p is quiet for a builtin (still found), -P finds the
    # file behind one, and misses one that has none.
    assert (
        _out(handle_type(["-p", "cat"], make_session(), make_registry()))
        == "/usr/bin/cat\n"
    )
    assert (
        _out(handle_type(["-p", "echo"], make_session(), make_registry()))
        == ""
    )
    assert (
        _out(handle_type(["-P", "echo"], make_session(), make_registry()))
        == "/usr/bin/echo\n"
    )
    assert (
        _out(handle_type(["-ap", "echo"], make_session(), make_registry()))
        == "/usr/bin/echo\n"
    )
    _, io, _ = handle_type(["-P", "cd"], make_session(), make_registry())
    assert io.exit_code == 1


def test_type_a_prints_every_layer():
    session = make_session()
    session.functions["linear"] = "linear() { :; }"
    assert _out(
        handle_type(["-a", "linear"], session, make_registry(True))
    ) == (
        "linear is a function\nlinear () \n{ \n    :\n}\n"
        "linear is /usr/bin/linear\n"
    )
    assert (
        _out(handle_type(["-at", "linear"], session, make_registry(True)))
        == "function\nfile\n"
    )
    assert _out(
        handle_type(["-a", "echo"], make_session(), make_registry())
    ) == ("echo is a shell builtin\necho is /usr/bin/echo\n")


def test_type_f_skips_functions_without_touching_the_session():
    session = make_session()
    body: list[str] = []
    session.functions["linear"] = body
    assert (
        _out(handle_type(["-f", "linear"], session, make_registry(True)))
        == "linear is /usr/bin/linear\n"
    )
    assert session.functions["linear"] is body


def test_type_f_on_a_function_only_name_is_not_found():
    session = make_session()
    session.functions["myfn"] = "myfn() { :; }"
    out, io, _ = handle_type(["-f", "myfn"], session, make_registry())
    assert out is None
    assert io.exit_code == 1


def test_type_not_found_warns_and_exits_1():
    out, io, _ = handle_type(["nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"bash: type: nope: not found\n"


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
    assert io.stderr.startswith(b"bash: type: -x: invalid option\n")


@pytest.mark.parametrize("name", ["linear", "cat", "echo", "xargs"])
def test_which_prints_the_file_of_every_program(name: str):
    out, io, _ = handle_which([name], make_session(), make_registry(True))
    assert out.decode() == f"/usr/bin/{name}\n"
    assert io.exit_code == 0


def test_which_misses_a_builtin_with_no_program():
    # debianutils which: cd is bash's alone, so nothing and exit 1.
    out, io, _ = handle_which(["cd"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


def test_which_miss_is_silent_and_exits_1():
    out, io, _ = handle_which(["nope"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1
    assert not io.stderr


def test_which_does_not_resolve_a_keyword():
    out, io, _ = handle_which(["if"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


def test_which_does_not_resolve_a_function():
    # `which` searches PATH, which holds no function.
    session = make_session()
    session.functions["then"] = "then() { :; }"
    session.functions["myfn"] = "myfn() { :; }"
    for name in ("then", "myfn"):
        out, io, _ = handle_which([name], session, make_registry())
        assert out is None
        assert io.exit_code == 1


def test_which_all_found_exit_rule():
    out, io, _ = handle_which(["cat", "nope"], make_session(), make_registry())
    assert out.decode() == "/usr/bin/cat\n"
    assert io.exit_code == 1


def test_which_no_operands_exits_1():
    out, io, _ = handle_which([], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 1


def test_which_a_prints_the_one_file_past_a_shadowing_function():
    # One directory on PATH, so one line; the function has no file.
    session = make_session()
    session.functions["linear"] = "linear() { :; }"
    out, io, _ = handle_which(["-a", "linear"], session, make_registry(True))
    assert out.decode() == "/usr/bin/linear\n"
    assert io.exit_code == 0


def test_which_s_reports_through_the_status():
    out, io, _ = handle_which(["-s", "cat"], make_session(), make_registry())
    assert out is None
    assert io.exit_code == 0
    assert (
        handle_which(["-s", "nope"], make_session(), make_registry())[
            1
        ].exit_code
        == 1
    )


def test_which_invalid_option():
    out, io, _ = handle_which(["-z", "cd"], make_session(), make_registry())
    assert io.exit_code == 2
    assert io.stderr.startswith(b"which: -z: invalid option\n")
