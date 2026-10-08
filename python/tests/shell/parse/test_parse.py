# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest
import tree_sitter

from mirage.shell import parse
from mirage.shell.helpers import (
    get_command_name,
    get_for_parts,
    get_if_branches,
    get_list_parts,
    get_parts,
    get_pipeline_commands,
    get_redirects,
    get_text,
    get_while_parts,
)
from mirage.shell.types import NodeType as NT


def test_parse_returns_node():
    root = parse("echo hello")
    assert isinstance(root, tree_sitter.Node)


def test_parse_root_is_program():
    root = parse("echo hello")
    assert root.type == "program"


def test_simple_command():
    cmd = parse("echo hello").named_children[0]
    assert cmd.type == NT.COMMAND
    assert get_command_name(cmd) == "echo"


def test_command_with_flags():
    cmd = parse("grep -n pattern /s3/file").named_children[0]
    parts = get_parts(cmd)
    texts = [get_text(p) for p in parts]
    assert texts == ["grep", "-n", "pattern", "/s3/file"]


def test_pipeline():
    node = parse("grep p file | sort").named_children[0]
    assert node.type == NT.PIPELINE
    cmds, stderr = get_pipeline_commands(node)
    assert len(cmds) == 2
    assert stderr == [False]


def test_multi_pipe():
    node = parse("cat f | grep p | sort | uniq").named_children[0]
    cmds, stderr = get_pipeline_commands(node)
    assert len(cmds) == 4
    assert stderr == [False, False, False]


def test_pipe_stderr():
    node = parse("cmd1 |& cmd2").named_children[0]
    cmds, stderr = get_pipeline_commands(node)
    assert stderr == [True]


def test_list_and():
    node = parse("cmd1 && cmd2").named_children[0]
    assert node.type == NT.LIST
    left, op, right = get_list_parts(node)
    assert op == NT.AND


def test_list_or():
    node = parse("cmd1 || cmd2").named_children[0]
    left, op, right = get_list_parts(node)
    assert op == NT.OR


def test_semicolon_multiple():
    root = parse("cmd1; cmd2; cmd3")
    assert len(root.named_children) == 3


def test_redirect_on_list_detected():
    """tree-sitter parses 'a || echo x > file' with > on the list.

    The executor re-associates this shape to the last command
    (execute_node NodeKind.REDIRECT), so the parse must keep exposing
    the list body.
    """
    node = parse("a || echo x > /out.txt").named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    body, redirects = get_redirects(node)
    assert body.type == NT.LIST
    assert len(redirects) == 1


def test_redirect_on_and_chain_detected():
    """tree-sitter hoists > from 'a && echo x > file'."""
    node = parse("a && echo x > /out.txt").named_children[0]
    body, redirects = get_redirects(node)
    assert body.type == NT.LIST
    assert len(redirects) == 1


def test_redirect_on_simple_command_not_list():
    """Normal redirect on a command is not a list redirect."""
    node = parse("echo hello > /out.txt").named_children[0]
    body, redirects = get_redirects(node)
    assert body.type == NT.COMMAND
    assert len(redirects) == 1


def test_subshell():
    node = parse("(grep p file | sort)").named_children[0]
    assert node.type == NT.SUBSHELL


def test_if_simple():
    node = parse("if true; then echo yes; fi").named_children[0]
    assert node.type == NT.IF_STATEMENT
    branches, else_body = get_if_branches(node)
    assert len(branches) == 1
    assert else_body is None


def test_if_else():
    node = parse("if true; then echo yes; else echo no; fi").named_children[0]
    branches, else_body = get_if_branches(node)
    assert else_body is not None


def test_if_elif_else():
    node = parse(
        "if true; then echo a; elif false; then echo b; else echo c; fi"
    ).named_children[0]
    branches, else_body = get_if_branches(node)
    assert len(branches) == 2
    assert else_body is not None


def test_for_loop():
    node = parse("for x in a b c; do echo; done").named_children[0]
    assert node.type == NT.FOR_STATEMENT
    var, values, body = get_for_parts(node)
    assert var == "x"
    assert [get_text(v) for v in values] == ["a", "b", "c"]


def test_while_loop():
    node = parse("while true; do echo loop; done").named_children[0]
    assert node.type == NT.WHILE_STATEMENT
    test, body = get_while_parts(node)
    assert [get_text(t) for t in test] == ["true"]


def test_until_loop():
    node = parse("until false; do echo loop; done").named_children[0]
    assert node.type == NT.WHILE_STATEMENT
    assert node.children[0].type == NT.UNTIL


def test_select():
    node = parse("select opt in a b c; do echo; done").named_children[0]
    assert node.type == NT.FOR_STATEMENT
    assert node.children[0].type == NT.SELECT
    var, values, body = get_for_parts(node)
    assert var == "opt"
    assert [get_text(v) for v in values] == ["a", "b", "c"]


def test_case():
    node = parse("case $x in a) echo A;; b) echo B;; esac").named_children[0]
    assert node.type == NT.CASE_STATEMENT


def test_function():
    node = parse("foo() { echo hello; }").named_children[0]
    assert node.type == NT.FUNCTION_DEFINITION


def test_export():
    node = parse("export FOO=bar").named_children[0]
    assert node.type == NT.DECLARATION_COMMAND


def test_unset():
    node = parse("unset FOO").named_children[0]
    assert node.type == NT.UNSET_COMMAND


def test_test_bracket():
    node = parse("[ -f /file ]").named_children[0]
    assert node.type == NT.TEST_COMMAND


def test_test_double_bracket():
    node = parse("[[ -f /file ]]").named_children[0]
    assert node.type == NT.TEST_COMMAND


def test_background():
    root = parse("cmd &")
    has_bg = any(c.type == NT.BACKGROUND for c in root.children)
    assert has_bg


def test_empty():
    root = parse("")
    assert len(root.named_children) == 0


def test_preserves_expansions():
    cmd = parse("echo $VAR $(cmd) $((1+2))").named_children[0]
    types = {c.type for c in cmd.named_children}
    assert NT.SIMPLE_EXPANSION in types
    assert NT.COMMAND_SUBSTITUTION in types
    assert NT.ARITHMETIC_EXPANSION in types


def test_preserves_quotes():
    cmd = parse("echo \"hello\" 'world'").named_children[0]
    types = [c.type for c in cmd.named_children if c.type != NT.COMMAND_NAME]
    assert NT.STRING in types
    assert NT.RAW_STRING in types


def test_complex_command():
    root = parse(
        "for f in $(ls /data/); do cat $f | grep error > /out/$f; done"
    )
    assert root.named_children[0].type == NT.FOR_STATEMENT


def test_chained_and_or():
    node = parse("cmd1 && cmd2 || cmd3").named_children[0]
    assert node.type == NT.LIST


def test_heredoc():
    node = parse("cat <<EOF\nhello\nEOF").named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT


def test_process_substitution():
    cmd = parse("diff <(sort a) <(sort b)").named_children[0]
    parts = get_parts(cmd)
    ps = [p for p in parts if p.type == NT.PROCESS_SUBSTITUTION]
    assert len(ps) == 2


def test_negated_command():
    node = parse("! echo hello").named_children[0]
    assert node.type == NT.NEGATED_COMMAND


@pytest.mark.parametrize(
    "command, body",
    [
        ("cat <<'EOF'\n\\first\nsecond\nEOF", "\\first\nsecond\n"),
        (
            "cat <<'EOF'\n\\first\n\\second\nthird\nEOF",
            "\\first\n\\second\nthird\n",
        ),
        ("cat <<'EOF'\n  first\nsecond\nEOF", "  first\nsecond\n"),
        (
            "cat <<'EOF'\n\\begin{table}\n  \\begin{center}\nEOF",
            "\\begin{table}\n  \\begin{center}\n",
        ),
        ("cat <<'EOF'\n\\item Don't\nsecond\nEOF", "\\item Don't\nsecond\n"),
        ('cat <<"E\\$F"\n\\first\nE$F', "\\first\n"),
    ],
)
def test_heredoc_reader_preserves_body_and_source(command, body):
    root = parse(command)
    assert not root.has_error
    assert root.source_text.decode() == command
    redirect = root.named_children[0].named_children[-1]
    assert redirect.heredoc.body.decode() == body


def test_heredoc_reader_exposes_expansions_as_ordinary_string_children():
    root = parse("cat <<EOF\n\\a $v `echo body`\nEOF")
    word = root.named_children[0].named_children[-1].named_children[-1]
    assert NT.SIMPLE_EXPANSION in [child.type for child in word.named_children]
    assert NT.COMMAND_SUBSTITUTION in [
        child.type for child in word.named_children
    ]


def test_heredoc_reader_keeps_escaped_dollars_literal():
    root = parse("cat <<EOF\n\\$v\nEOF")
    word = root.named_children[0].named_children[-1].named_children[-1]
    assert NT.SIMPLE_EXPANSION not in [
        child.type for child in word.named_children
    ]


def test_heredoc_reader_keeps_pipeline_outside_body():
    root = parse("cat <<'EOF' | tr a-z A-Z\n\\first\nEOF")
    pipeline = root.named_children[0]
    assert pipeline.type == NT.PIPELINE
    assert get_text(pipeline.named_children[-1]) == "tr a-z A-Z"


# ── heredoc operator lines the grammar cannot hold ───────────────────────


def _heredoc_bodies_by_delimiter(command: str) -> dict[str, str]:
    root = parse(command)
    assert not root.has_error
    found: dict[str, str] = {}
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        document = getattr(node, "heredoc", None)
        if document is not None:
            found[document.delimiter] = document.body.decode()
    return found


# Keep the operator-line regressions from #1071. The source reader now
# preserves their typed source while lowering bodies before grammar parsing.
@pytest.mark.parametrize(
    "command",
    [
        "cat <<EOF; echo x\nhi\nEOF\n",
        "cat <<EOF;echo x\nhi\nEOF\n",
        "cat <<EOF>out\nhi\nEOF\n",
        "cat <<EOF|wc -l\nhi\nEOF\n",
        "cat <<EOF&&echo x\nhi\nEOF\n",
        "cat <<'EOF'; echo x\nhi\nEOF\n",
        "cat <<EOF;\nhi\nEOF;\nEOF\n",
        "(cat <<EOF)\nhi\nEOF)\nEOF\n",
        "cat <<A && cat <<B\na\nA\nb\nB\n",
        "cat <<A; cat <<B\na\nA\nb\nB\n",
        "(cat <<EOF)\nhi\nEOF\n",
        "case x in x) cat <<EOF;; esac\nhi\nEOF\n",
        "{ cat <<EOF; }\nhi\nEOF\n",
    ],
)
def test_heredoc_operator_line_preserves_original_source(command):
    root = parse(command)
    assert not root.has_error
    assert root.source_text.decode() == command


def test_two_heredocs_on_one_line_keep_their_own_bodies():
    assert _heredoc_bodies_by_delimiter(
        "cat <<A && cat <<B\na\nA\nb\nB\n"
    ) == {
        "A": "a\n",
        "B": "b\n",
    }
    assert _heredoc_bodies_by_delimiter(
        "cat <<A | cat <<B; cat <<C\na\nA\nb\nB\nc\nC\n"
    ) == {
        "A": "a\n",
        "B": "b\n",
        "C": "c\n",
    }


def test_heredoc_semicolon_tail_keeps_the_bodys_indentation():
    # The shield runs on the relaid source too.
    assert _heredoc_bodies_by_delimiter("cat <<EOF; echo x\n  hi\nEOF\n") == {
        "EOF": "  hi\n",
    }


def test_heredoc_metacharacter_inside_a_quoted_delimiter_is_the_delimiter():
    assert _heredoc_bodies_by_delimiter("cat <<'EOF;'\nhi\nEOF;\n") == {
        "EOF;": "hi\n",
    }


def test_heredoc_delimiter_word_is_checked_on_a_clean_tree():
    # `EOF;` is tree-sitter's token and a body line at once, so the typed
    # source parses clean with a body one line short; bash's word is EOF.
    assert _heredoc_bodies_by_delimiter(
        "cat <<EOF; echo x\nhi\nEOF;\nEOF\n"
    ) == {
        "EOF": "hi\nEOF;\n",
    }
    assert _heredoc_bodies_by_delimiter(
        "cat <<EOF|tr a-z A-Z\nhi\nEOF|tr a-z A-Z\nEOF\n"
    ) == {
        "EOF": "hi\nEOF|tr a-z A-Z\n",
    }


def test_heredoc_body_keeps_a_line_that_only_opens_with_the_delimiter():
    # tree-sitter-bash's scanner compares a line's first bytes with the
    # delimiter and stops there; bash wants the whole line.
    assert _heredoc_bodies_by_delimiter(
        "cat <<EOF\nEOFX\nEOF;\n EOF\nEOF\n"
    ) == {
        "EOF": "EOFX\nEOF;\n EOF\n",
    }
    assert _heredoc_bodies_by_delimiter(
        "cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n"
    ) == {
        "EOF": "hi\nEOFX\n  EOF\n",
    }


def test_heredoc_lookalike_line_keeps_its_expansion():
    root = parse("cat <<EOF\nEOF$v\nEOF\n")
    redirect = root.named_children[0].named_children[-1]
    assert redirect.heredoc.body == b"EOF$v\n"
    word = redirect.named_children[-1]
    assert NT.SIMPLE_EXPANSION in [c.type for c in word.named_children]


def test_heredoc_unterminated_body_is_left_as_typed():
    root = parse("cat <<EOF; echo x\nhi\n")
    assert not root.has_error
    assert root.source_text.decode() == "cat <<EOF; echo x\nhi\n"
    assert root.warnings


@pytest.mark.parametrize(
    "line, words",
    [
        ("echo ==", ["echo", "=="]),
        ("echo == x", ["echo", "==", "x"]),
        ("echo a =~ b", ["echo", "a", "=~", "b"]),
        ("echo =~ a.b*", ["echo", "=~", "a.b*"]),
        ("test a == a", ["test", "a", "==", "a"]),
        ('echo =="x"', ["echo", '=="x"']),
    ],
)
def test_a_test_operator_as_an_argument_is_the_word_bash_reads(line, words):
    # tree-sitter-bash takes `==`/`=~` there for a `[`-style operator that
    # wants an operand, so `echo ==` failed and `echo == x` lost the word.
    root = parse(line)
    assert not root.has_error
    assert [get_text(p) for p in get_parts(root.named_children[0])] == words


@pytest.mark.parametrize(
    "line",
    [
        "echo ==; echo hi",
        "echo == | cat",
        "echo ==&& echo hi",
        "f() { echo ==; }",
        "case x in x) echo ==;; esac",
        "echo $; echo hi",
    ],
)
def test_an_operator_word_before_a_terminator_is_no_syntax_error(line):
    assert not parse(line).has_error


def test_a_redirect_after_an_operator_word_stays_a_redirect():
    # The operand the grammar wanted after `==` swallowed `>/dev/null`.
    command, redirects = get_redirects(
        parse("echo == >/dev/null").named_children[0]
    )
    assert [get_text(p) for p in get_parts(command)] == ["echo", "=="]
    assert [r.target for r in redirects] == ["/dev/null"]


def test_the_translation_marker_stays_with_its_string():
    command = parse('echo $"hello"').named_children[0]
    assert [get_text(p) for p in get_parts(command)] == ["echo", '"hello"']


@pytest.mark.parametrize(
    "line, operator",
    [("[[ a == b ]]", "=="), ("[ a =~ b ]", "=~"), ("(( 1 == 1 ))", "==")],
)
def test_an_operator_inside_a_test_stays_an_operator(line, operator):
    expression = parse(line).named_children[0].named_children[0]
    assert expression.type == NT.BINARY_EXPRESSION
    assert [c.type for c in expression.children if not c.is_named] == [
        operator
    ]


def _nodes(node, kind: str) -> list:
    found = [node] if node.type == kind else []
    for child in node.named_children:
        found.extend(_nodes(child, kind))
    return found


@pytest.mark.parametrize(
    "line, commands",
    [
        ("[ a && b ]", [["[", "a"], ["b", "]"]]),
        ("[ a | b ]", [["[", "a"], ["b", "]"]]),
        ("[ a ]]", [["[", "a", "]]"]]),
        ("[ a ]x", [["[", "a", "]x"]]),
        ("[ a; echo x", [["[", "a"], ["echo", "x"]]),
        ("[ c", [["[", "c"]]),
        ("[ \\( a \\) ]", [["[", "\\(", "a", "\\)", "]"]]),
    ],
)
def test_a_bracket_bash_reads_as_a_command_parses_as_one(line, commands):
    # `[` is a command to bash: its words stop at a list or pipe operator
    # and need a `]` of their own, where the grammar builds a test anyway.
    root = parse(line)
    assert not root.has_error
    assert [
        [get_text(p) for p in get_parts(c)] for c in _nodes(root, NT.COMMAND)
    ] == commands


@pytest.mark.parametrize(
    "line",
    [
        "[ a ] && [ b ]",
        "[ a -a b ]",
        '[ "a && b" ]',
        "[ a ]>/dev/null",
        "( [ a ])",
        "[ ! a ]",
    ],
)
def test_a_well_formed_bracket_test_stays_a_test(line):
    root = parse(line)
    assert _nodes(root, NT.TEST_COMMAND)
    assert not any(
        get_command_name(c) == "[" for c in _nodes(root, NT.COMMAND)
    )
