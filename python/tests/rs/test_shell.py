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
def test_tree_reads_as_bash_reads(
    line: str, sexp: str
) -> None:
    tree = parse_shell(line)
    assert tree.error is None
    assert _sexp(tree.root_node) == sexp


def test_a_refused_line_reports_bash_words() -> None:
    tree = parse_shell("if true; then")
    assert tree.root_node.has_error
    assert tree.error == (13, "syntax error: unexpected end of file")
    assert parse_shell("echo a; fi").error == (
        8,
        "syntax error near unexpected token `fi'",
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
