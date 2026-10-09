from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import CommandSpec
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.lookup.classify import (
    classify,
    classify_all,
    describe,
)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.session.session import SessionState

TREE = CLI(
    spec=CommandSpec(name="linear", subcommands=(CommandSpec(name="issue"),)),
    handlers={"issue": CLIHandler(fn=lambda: None)},
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


def test_classify_keyword_before_route():
    session = make_session()
    registry = make_registry()
    for kw in ("if", "for", "while", "case", "[[", "]]", "!", "{", "}"):
        assert classify(kw, session, registry) is NameKind.KEYWORD


def test_classify_bash_builtins_are_builtins_and_programs_are_files():
    session = make_session()
    registry = make_registry()
    assert classify("cd", session, registry) is NameKind.BUILTIN
    assert classify("echo", session, registry) is NameKind.BUILTIN
    assert classify("cat", session, registry) is NameKind.FILE
    assert classify("jq", session, registry) is NameKind.FILE
    # Not one of bash's builtins, so a program with a file (GNU xargs).
    assert classify("xargs", session, registry) is NameKind.FILE


def test_classify_function_and_not_found():
    session = make_session()
    session.functions["myfn"] = "myfn() { :; }"
    registry = make_registry()
    assert classify("myfn", session, registry) is NameKind.FUNCTION
    assert classify("nope_xyz", session, registry) is None


def test_classify_installed_cli():
    assert (
        classify("linear", make_session(), make_registry(True))
        is NameKind.FILE
    )


def test_classify_all_reports_a_function_shadowing_a_cli():
    session = make_session()
    registry = make_registry(True)
    assert classify_all("linear", session, registry) == [NameKind.FILE]
    session.functions["linear"] = "linear() { :; }"
    assert classify_all("linear", session, registry) == [
        NameKind.FUNCTION,
        NameKind.FILE,
    ]


def test_classify_all_dedupes_one_kind_held_by_two_layers():
    session = make_session()
    registry = FakeRegistry({"readlink"})
    assert classify_all("readlink", session, registry) == [NameKind.FILE]


def test_classify_all_ends_a_builtin_that_is_also_a_program_with_its_file():
    # bash: `type -a echo` prints the builtin line, then /usr/bin/echo.
    session = make_session()
    registry = make_registry()
    assert classify_all("echo", session, registry) == [
        NameKind.BUILTIN,
        NameKind.FILE,
    ]
    assert classify_all("cd", session, registry) == [NameKind.BUILTIN]


def test_classify_all_keeps_the_layers_under_a_keyword():
    # bash: `function time { :; }; type -a time` prints the keyword line
    # then the function line.
    session = make_session()
    session.functions["then"] = "then() { :; }"
    assert classify_all("then", session, make_registry()) == [
        NameKind.KEYWORD,
        NameKind.FUNCTION,
    ]


def test_time_is_a_keyword_and_coproc_is_unimplemented():
    session = make_session()
    registry = make_registry()
    assert classify("time", session, registry) is NameKind.KEYWORD
    assert classify("coproc", session, registry) is None
    session.functions["time"] = "time() { :; }"
    assert classify("time", session, registry) is NameKind.KEYWORD


def test_describe_lines():
    assert describe("if", NameKind.KEYWORD) == "if is a shell keyword"
    assert describe("myfn", NameKind.FUNCTION) == "myfn is a function"
    assert describe("cat", NameKind.BUILTIN) == "cat is a shell builtin"
    assert describe("linear", NameKind.FILE) == "linear is /usr/bin/linear"
