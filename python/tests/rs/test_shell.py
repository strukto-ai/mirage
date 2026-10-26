from typing import Any

import pytest

from mirage.rs.shell import parse_shell

BASH = [
    (
        "exec 0>f",
        "(program (redirected_statement body: (command name: (command_name"
        " (word))) redirect: (file_redirect descriptor: (file_descriptor)"
        " destination: (word))))",
    ),
    (
        "time a | b",
        "(program (timed_statement (pipeline (command name: (command_name"
        " (word))) (command name: (command_name (word))))))",
    ),
    (
        "! { a; }",
        "(program (negated_command (compound_statement (command name:"
        " (command_name (word))))))",
    ),
    (
        "echo $10",
        "(program (command name: (command_name (word)) argument:"
        " (concatenation (simple_expansion (variable_name)) (number))))",
    ),
]


def _sexp(node: Any, field: str | None = None) -> str:
    head = f"{field}: " if field else ""
    named = [
        _sexp(child, node.field_name_for_child(i))
        for i, child in enumerate(node.children)
        if child.is_named
    ]
    inner = " ".join([node.type, *named])
    return f"{head}({inner})"


@pytest.mark.parametrize("line,sexp", BASH)
def test_tree_reads_as_bash_reads(line: str, sexp: str) -> None:
    tree = parse_shell(line)
    assert tree.error is None
    assert _sexp(tree.root_node) == sexp


def test_a_refused_line_reports_bash_words() -> None:
    tree = parse_shell("if true; then")
    assert tree.error == (
        13,
        b"mirage: syntax error: unexpected end of file\n",
        2,
    )
    assert parse_shell("echo a; fi").error == (
        8,
        b"mirage: syntax error near 'fi'\n",
        2,
    )
    # With extglob off a pattern group is no word.
    assert parse_shell("echo @(a)").error is None
    assert parse_shell("echo @(a)", extglob=False).error == (
        6,
        b"mirage: syntax error near '('\n",
        2,
    )


def test_nodes_link_to_their_family() -> None:
    root = parse_shell("a=1 echo hi > f").root_node
    statement = root.children[0]
    command, redirect = statement.children
    assert statement.parent == root and root.parent is None
    assert command.next_sibling == redirect
    assert redirect.prev_sibling == command
    assert redirect.next_sibling is None
    assert statement.child_by_field_name("redirect") == redirect
    assert statement.child(1) == redirect and statement.child(2) is None
    name = command.child_by_field_name("name")
    assert name is not None and name.text == b"echo"
    assert [n.type for n in command.named_children] == [
        "variable_assignment",
        "command_name",
        "word",
    ]
    assert command.field_name_for_child(2) == "argument"


def test_ids_differ_across_trees() -> None:
    one = parse_shell("a").root_node
    two = parse_shell("a").root_node
    assert one.id != two.id
    assert one.children[0].id == one.children[0].id
    assert len({hash(node) for node in (one, two)}) == 2


@pytest.mark.parametrize(
    "command,expected",
    [
        # An odd-length trailing run ends in a live continuation.
        ("echo a\\", "echo a"),
        ("echo a\\\\\\", "echo a\\\\"),
        ("echo \\", "echo "),
        # An even-length run is all escaped backslashes, so nothing goes.
        ("echo a\\\\", "echo a\\\\"),
        ("echo a\\\\\\\\", "echo a\\\\\\\\"),
        ("echo a", "echo a"),
        ("echo a\\ b", "echo a\\ b"),
        # Mid-line, the pair goes wherever the reader sees it.
        ("echo a\\\nb", "echo ab"),
        ('echo "a\\\nb"', 'echo "ab"'),
        ("echo $\\\n{x} $((1\\\n+2))", "echo ${x} $((1+2))"),
        ("ec\\\nho a", "echo a"),
        ("echo a\\\\\nb", "echo a\\\\\nb"),
        ("echo a\\\\\\\nb", "echo a\\\\b"),
        # Single-quoted and ANSI-C text and comments keep theirs.
        ("echo 'a\\\nb'", "echo 'a\\\nb'"),
        ("echo $'a\\\nb'", "echo $'a\\\nb'"),
        ("echo a # c \\\necho b", "echo a # c \\\necho b"),
        ("echo \"$(echo 'u\\\nv')\"", "echo \"$(echo 'u\\\nv')\""),
        ('echo "it\'s a\\\nb"', 'echo "it\'s ab"'),
    ],
)
def test_the_tree_reads_the_line_with_its_continuations_dropped(
    command: str, expected: str
) -> None:
    assert parse_shell(command).source == expected.encode()


def test_a_quoted_heredoc_body_keeps_its_continuations() -> None:
    tree = parse_shell("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    assert tree.source == b'cat <"a\\\\\nb\n" | tr a b\n'
    assert tree.root_node.source_text == b"cat <<'E' | \\\ntr a b\na\\\nb\nE"


def test_an_unquoted_heredoc_body_joins_its_lines() -> None:
    tree = parse_shell("cat <<E | \\\ntr a b\na\\\nb $x\nE")
    assert tree.source == b'cat <"ab $x\n" | tr a b\n'


@pytest.mark.parametrize(
    "command",
    [
        "echo A; \\\n fi",
        "echo /api/$c/$id.json; fi",
        "! echo A \\\n; fi",
        "time echo A \\\n; fi",
        "cat <<E; fi\nbody\nE",
    ],
    ids=["continuation", "expansion", "bang", "time", "heredoc"],
)
def test_offsets_point_back_into_the_line_as_typed(command: str) -> None:
    # The stray `fi` is where the parser refuses each line.
    root = parse_shell(command).root_node
    (error,) = (node for node in root.children if node.type == "ERROR")
    assert root.offsets[error.start_byte] == command.encode().rindex(b"fi")
