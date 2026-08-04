from mirage.commands.cli.types import CLISpec
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.lookup.classify import (classify,
                                                                classify_all,
                                                                describe)
from mirage.workspace.executor.builtins.lookup.types import NameKind
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


def test_classify_keyword_before_route():
    session = make_session()
    registry = make_registry()
    for kw in ("if", "for", "while", "case", "[[", "]]", "!", "{", "}"):
        assert classify(kw, session, registry) is NameKind.KEYWORD


def test_classify_shell_builtin_and_mount_are_builtin():
    session = make_session()
    registry = make_registry()
    assert classify("cd", session, registry) is NameKind.BUILTIN
    assert classify("echo", session, registry) is NameKind.BUILTIN
    assert classify("cat", session, registry) is NameKind.BUILTIN
    assert classify("jq", session, registry) is NameKind.BUILTIN


def test_classify_function_and_not_found():
    session = make_session()
    session.functions["myfn"] = []
    registry = make_registry()
    assert classify("myfn", session, registry) is NameKind.FUNCTION
    assert classify("nope_xyz", session, registry) is None


def test_classify_installed_cli():
    assert classify("linear", make_session(),
                    make_registry(True)) is NameKind.CLI


def test_classify_all_reports_a_function_shadowing_a_cli():
    session = make_session()
    registry = make_registry(True)
    assert classify_all("linear", session, registry) == [NameKind.CLI]
    session.functions["linear"] = []
    assert classify_all("linear", session,
                        registry) == [NameKind.FUNCTION, NameKind.CLI]


def test_classify_all_dedupes_one_kind_held_by_two_layers():
    session = make_session()
    registry = FakeRegistry({"cd"})
    assert classify_all("cd", session, registry) == [NameKind.BUILTIN]


def test_classify_all_keeps_the_layers_under_a_keyword():
    # bash: `function time { :; }; type -a time` prints the keyword line
    # then the function line.
    session = make_session()
    session.functions["then"] = []
    assert classify_all("then", session, make_registry()) == [
        NameKind.KEYWORD, NameKind.FUNCTION
    ]


def test_time_and_coproc_are_not_keywords_here():
    # mirage implements neither construct, so `time echo hi` reports
    # command not found and type may not call it a keyword.
    session = make_session()
    registry = make_registry()
    assert classify("time", session, registry) is None
    assert classify("coproc", session, registry) is None
    session.functions["time"] = []
    assert classify("time", session, registry) is NameKind.FUNCTION


def test_describe_lines():
    assert describe("if", NameKind.KEYWORD) == "if is a shell keyword"
    assert describe("myfn", NameKind.FUNCTION) == "myfn is a function"
    assert describe("cat", NameKind.BUILTIN) == "cat is a shell builtin"
    assert describe("linear", NameKind.CLI) == "linear is a mirage CLI"
