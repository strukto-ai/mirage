from typing import Any

import pytest
import tree_sitter
import tree_sitter_bash

from mirage.rs.shell import parse_shell

GRAMMAR = tree_sitter.Parser(tree_sitter.Language(tree_sitter_bash.language()))

# Lines both parsers read alike: tree-sitter-bash's shapes, spans and
# points, the grammar's quirks included.
SAME = [
    "echo hi",
    "echo a > f b 2>&1 | tr a b && x=1 y=2",
    "a | b > f | c",
    "! a && b || c &",
    "echo \"a $b ${c} $(d) `e`\" 'f' $'g\\n'",
    'printf "%s" "$x $y" "$x  y" "$x "',
    "echo {1..3} {a,b} ] ]",
    "x=(1 2) a[i+1]=v declare -r y=1 z",
    "echo ${a:-two words} ${a#*/} ${a/x/ $f} ${x:1:2} ${#a[@]} ${!p*}",
    "echo $(( a + b * -c )) $[1] && (( i++, j-- ))",
    "[[ $x == a* && -f f ]] || [ ! -e g ]",
    "case $x in a|b) echo ab;; *.txt) ;& (c) echo c;; esac",
    "for i in 1 2; do echo $i; done; for ((i=0; i<3; i++)); do :; done",
    "f() { local v=$1; } # trailing",
    'while read -r l; do echo "$l"; done < f',
    "cat <<EOF | wc -l\nline $x\nEOF",
    "cat <<-'E'\n\tbody\n\tE",
    "echo héllo wörld 💡 | tr é e",
    'echo "日本 $x 😀"',
]

# Lines tree-sitter-bash misreads, as bash reads them.
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


def _canon(node: Any, field: str | None = None) -> tuple[Any, ...]:
    return (
        node.type,
        node.is_named,
        field,
        node.start_byte,
        node.end_byte,
        tuple(node.start_point),
        tuple(node.end_point),
        node.is_missing,
        [
            _canon(child, node.field_name_for_child(i))
            for i, child in enumerate(node.children)
        ],
    )


def _sexp(node: Any, field: str | None = None) -> str:
    head = f"{field}: " if field else ""
    named = [
        _sexp(child, node.field_name_for_child(i))
        for i, child in enumerate(node.children)
        if child.is_named
    ]
    inner = " ".join([node.type, *named])
    return f"{head}({inner})"


@pytest.mark.parametrize("line", SAME)
def test_tree_matches_tree_sitter_bash(line: str) -> None:
    data = line.encode()
    want = GRAMMAR.parse(data).root_node
    got = parse_shell(line).root_node
    assert not want.has_error
    assert _canon(got) == _canon(want)


@pytest.mark.parametrize("line,sexp", BASH)
def test_tree_follows_bash_where_the_grammar_misreads(
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
