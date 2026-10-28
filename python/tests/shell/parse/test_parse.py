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

import json
from pathlib import Path

import pytest

from mirage.shell import parse
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.escapes import ends_escaped
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
from mirage.shell.parse import syntax_refusal
from mirage.shell.types import NodeType as NT
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ROOT = Path(__file__).resolve().parents[4]
CORPUS = json.loads(
    (ROOT / "integ/fixtures/shell/bash_syntax.json").read_text()
)["lines"]
SIDE_EFFECT_COMMANDS = [
    case["command"]
    for case in json.loads(
        (ROOT / "integ/bash/syntax/quoting.json").read_text()
    )["cases"]
    if "/data/unexpected" in case["command"]
]


# Rows of bash_syntax.json, pinned with `bash -c`, that mirage reads
# otherwise: a heredoc body whose substitution or expansion does not
# close, which bash refuses only when it expands the body and mirage with
# the line; and three lines the parser refuses at an earlier token than
# the one bash names. A line that ends in a backslash is read as a script
# reads it, the backslash continuing onto nothing, where `bash -c` keeps
# it.
DIVERGES = frozenset(
    {
        "cat <<EOF\n$(\nEOF",
        "cat <<EOF\n$(fi)\nEOF",
        "cat <<EOF\n${a\nEOF",
        "cat <<EOF\n`\nEOF",
        "declare a[x y]=(1)",
        "f() x=({\necho\n}",
        "{fd}>f x=(a[)",
    }
)


def _refusal(
    line: str, aliases: frozenset[str] = frozenset()
) -> tuple[int, bytes]:
    io = syntax_refusal(parse(line, aliases, extglob=False))
    return (0, b"") if io is None else (io.exit_code, io.stderr)


def test_parse_returns_node():
    root = parse("echo hello")
    assert root.type == "program"
    assert root.error is None


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
    """The parser hangs the > of 'a || echo x > file' on the list.

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
    """The parser hoists > from 'a && echo x > file'."""
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


@pytest.mark.parametrize(
    ("line", "kind"),
    [
        ("(grep p file | sort)", NT.SUBSHELL),
        ("case $x in a) echo A;; b) echo B;; esac", NT.CASE_STATEMENT),
        ("foo() { echo hello; }", NT.FUNCTION_DEFINITION),
        ("export FOO=bar", NT.DECLARATION_COMMAND),
        ("unset FOO", NT.UNSET_COMMAND),
        ("[ -f /file ]", NT.COMMAND),
        ("[[ -f /file ]]", NT.TEST_COMMAND),
        (
            "for f in $(ls /data/); do cat $f | grep error > /out/$f; done",
            NT.FOR_STATEMENT,
        ),
        ("cmd1 && cmd2 || cmd3", NT.LIST),
        ("cat <<EOF\nhello\nEOF", NT.REDIRECTED_STATEMENT),
        ("! echo hello", NT.NEGATED_COMMAND),
    ],
)
def test_statement_kind(line, kind):
    assert parse(line).named_children[0].type == kind


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


def test_process_substitution():
    cmd = parse("diff <(sort a) <(sort b)").named_children[0]
    parts = get_parts(cmd)
    ps = [p for p in parts if p.type == NT.PROCESS_SUBSTITUTION]
    assert len(ps) == 2


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
    assert root.error is None
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
    assert root.error is None
    found: dict[str, str] = {}
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        document = getattr(node, "heredoc", None)
        if document is not None:
            found[document.delimiter.decode()] = document.body.decode()
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
    assert root.error is None
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
    # `EOF;` is a body line, not the delimiter: bash's word is EOF.
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
    # bash ends a body only on a line that is the delimiter whole.
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


def test_heredoc_body_of_any_length_is_read():
    body = "line\n" * 100_000
    assert _heredoc_bodies_by_delimiter(f"cat <<'EOF' > f\n{body}EOF\n") == {
        "EOF": body,
    }


def test_heredoc_lookalike_line_keeps_its_expansion():
    root = parse("cat <<EOF\nEOF$v\nEOF\n")
    redirect = root.named_children[0].named_children[-1]
    assert redirect.heredoc.body == b"EOF$v\n"
    word = redirect.named_children[-1]
    assert NT.SIMPLE_EXPANSION in [c.type for c in word.named_children]


def test_heredoc_unterminated_body_is_left_as_typed():
    root = parse("cat <<EOF; echo x\nhi\n")
    assert root.error is None
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
    # `==` and `=~` are words outside a test: `echo ==` runs and
    # `echo == x` keeps the word.
    root = parse(line)
    assert root.error is None
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
    assert parse(line).error is None


def test_a_redirect_after_an_operator_word_stays_a_redirect():
    # The operand the grammar wanted after `==` swallowed `>/dev/null`.
    command, redirects = get_redirects(
        parse("echo == >/dev/null").named_children[0]
    )
    assert [get_text(p) for p in get_parts(command)] == ["echo", "=="]
    assert [r.target for r in redirects] == ["/dev/null"]


def test_the_translation_marker_stays_with_its_string():
    command = parse('echo $"hello"').named_children[0]
    assert [p.type for p in get_parts(command)] == [
        NT.COMMAND_NAME,
        NT.TRANSLATED_STRING,
    ]


@pytest.mark.parametrize(
    "line, operator",
    [("[[ a == b ]]", "=="), ("(( 1 == 1 ))", "==")],
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
        ("[ a ] && [ b ]", [["[", "a", "]"], ["[", "b", "]"]]),
        ("[ ! --x ]", [["[", "!", "--x", "]"]]),
        ("[ -1 -lt 2 -a ~x ]", [["[", "-1", "-lt", "2", "-a", "~x", "]"]]),
        ("( [ a ])", [["[", "a", "]"]]),
        ("[ ]", [["[", "]"]]),
    ],
)
def test_a_bracket_is_a_command(line, commands):
    # `[` is a command to bash: its words stop at a list or pipe operator,
    # need a `]` of their own, and reach test whole.
    root = parse(line)
    assert root.error is None
    assert [
        [get_text(p) for p in get_parts(c)] for c in _nodes(root, NT.COMMAND)
    ] == commands


@pytest.mark.parametrize(
    "command",
    [
        "echo hi > /api/$c/$id.json",
        "echo hi > /w/$c/$12.json",
        "echo hi > /é💡/$c/$123abc.json",
    ],
)
def test_a_redirect_target_is_one_word(command):
    node = parse(command).named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    _, redirects = get_redirects(node)
    assert [r.target for r in redirects] == [command.split("> ")[1]]


@pytest.mark.parametrize(
    "line",
    [
        "value=x 2>/dev/null; echo done",
        "  value=é💡 2>/dev/null; echo done",
        "value=$(echo x) 2>/dev/null && echo done",
    ],
)
def test_assignments_with_a_redirect_keep_their_source(line):
    raw = line.encode()
    pending = [parse(line)]
    while pending:
        node = pending.pop()
        assert node.text == raw[node.start_byte : node.end_byte]
        pending.extend(node.children)


@pytest.mark.parametrize(
    "source",
    [
        "echo ${x:$offset:2}",
        "if false; then echo ${x:.2f}; fi",
        "echo ${x:$(echo 1):${n:-2}}",
    ],
)
def test_a_substring_leaves_its_arithmetic_to_execution(source):
    root = parse(source)
    assert syntax_refusal(root) is None
    assert root.text.decode() == source


def _substitution(root):
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "command_substitution":
            return node
        stack.extend(reversed(node.named_children))
    raise AssertionError("no substitution")


def test_nested_evaluation_gets_original_heredoc_syntax():
    source = 'echo "$(cat <<EOF\nhello\nEOF\n)"'
    node = _substitution(parse(source))
    assert b"<<EOF" in node.source_text
    assert b"<<EOF" not in node.text


def test_nested_evaluation_keeps_reader_continuation_removal():
    node = _substitution(parse("cat <<EOF\n$(printf '%s' 'a\\\nb')\nEOF"))
    assert node.source_text == b"$(printf '%s' 'ab')"


def test_later_parse_cannot_replace_an_earlier_nodes_body():
    first = parse("cat <<EOF\none\nEOF")
    parse("cat <<EOF\ntwo\nEOF")
    assert first.named_children[0].named_children[-1].heredoc.body == b"one\n"


def test_extended_pattern_shield_preserves_original_rows():
    root = parse("echo @(😀\nb|c)\necho after")
    first, second = root.named_children
    assert first.text == "echo @(😀\nb|c)".encode()
    assert first.end_point == (1, 4)
    assert second.start_point == (2, 0)
    assert second.text == b"echo after"


def test_pattern_source_rows_across_a_long_script():
    root = parse("echo @(😀\nb|c)\n" * 1000 + "echo end")
    statements = root.named_children
    assert len(statements) == 1001
    for index in (0, 500, 999):
        assert statements[index].start_point == (2 * index, 0)
        assert statements[index].end_point == (2 * index + 1, 4)
    assert statements[-1].start_point == (2000, 0)


def test_heredoc_tokens_in_patterns_do_not_consume_later_commands():
    command = "echo @(a<<b|c)\ncat <<EOF\nbody\nEOF\necho after\n"
    root = parse(command)
    assert len(root.named_children) == 3
    assert root.named_children[0].text == b"echo @(a<<b|c)"
    assert root.named_children[-1].text == b"echo after"


@pytest.mark.parametrize(
    "command",
    [
        '[[ @ == [a"@"] ]]',
        '[[ $x == [a"$x"] ]]',
        'case "$x" in [a"$x"]) echo match;; esac',
    ],
)
def test_quoted_bracket_pattern_remains_one_operand(command):
    root = parse(command)
    assert root.error is None
    assert root.text == command.encode()
    stack, strings = [root], []
    while stack:
        node = stack.pop()
        stack.extend(node.named_children)
        if node.type == "string":
            strings.append(node.text)
    assert strings
    assert all(value in (b'"@"', b'"$x"') for value in strings)


def test_extended_pattern_keeps_process_substitution_in_one_word():
    root = parse("echo @(<(printf a)|b)")
    command = root.named_children[0]
    assert len(command.named_children) == 2
    word = command.named_children[1]
    assert word.type == "concatenation"
    sub = next(
        child
        for child in word.named_children
        if child.type == "process_substitution"
    )
    assert sub.text == b"<(printf a)"
    assert sub.children[0].type == "<("


def test_every_line_reads_as_bash_reads_it():
    # integ/fixtures/shell/bash_syntax.json is pinned against bash by
    # scripts/pin_bash_syntax.py, which also fuzzes the parser against it;
    # the TypeScript suite (packages/core/src/shell/parse/parse.test.ts)
    # reads the same rows.
    assert [
        row["line"]
        for row in CORPUS
        if row["line"] not in DIVERGES
        and not ends_escaped(row["line"])
        and _refusal(row["line"])
        != (row["status"], encode_text(row["stderr"]))
    ] == []


@pytest.mark.parametrize(
    ("raw", "stderr"),
    [
        (b"echo (\xff", b"mirage: syntax error near '\xff'\n"),
        (
            b"[[ '\xff'",
            b"mirage: unexpected token `newline', conditional binary "
            b"operator expected\nmirage: syntax error near ''\xff''\n",
        ),
    ],
)
def test_a_diagnostic_keeps_an_invalid_byte_as_typed(raw, stderr):
    assert _refusal(decode_text(raw))[1] == stderr


def test_a_line_nested_past_the_reader_is_refused_at_the_next_opener():
    # bash refuses a line nested past its own reader at the opener it can
    # no longer take (thousands deep there), so nothing on the line runs.
    deep = "echo " + "$(echo " * 4096 + "x" + ")" * 4096 + "; fi"
    assert _refusal(deep) == (127, b"mirage: syntax error near '$('\n")
    assert _refusal("{ " * 64 + "a; " + "} " * 64) == (0, b"")
    assert _refusal("{ " * 65 + "a; " + "} " * 64) == (
        2,
        b"mirage: syntax error near '{'\n",
    )
    bangs = "[[ " + "! " * 5000 + "x ]]"
    assert _refusal(bangs) == (2, b"mirage: syntax error: nesting too deep\n")


def test_a_substitution_is_read_once_however_often_its_word_is():
    assert _refusal("x=$(" * 40 + "echo hi" + ")" * 40) == (0, b"")


@pytest.mark.parametrize(
    ("command", "alias", "word"),
    [
        ("fi", "fi", None),
        ("fi", "done", "fi"),
        ("( fi )", "fi", None),
        ("echo `fi`", "fi", None),
        ('echo "$(fi)"', "fi", "fi"),
        ("echo $( (fi) )", "fi", "fi"),
        ("echo <(fi)", "fi", "fi"),
    ],
)
def test_a_reserved_word_the_shell_expands_as_an_alias_is_a_command(
    command, alias, word
):
    # Pinned against bash 5.2.37, which takes the reserved word first
    # inside `$(...)` and a process substitution.
    _, stderr = _refusal(command, frozenset({alias}))
    assert stderr == (
        b""
        if word is None
        else f"mirage: syntax error near '{word}'\n".encode()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ('echo "it\'s fine"', "it's fine\n"),
        ("echo ok # unterminated '\"", "ok\n"),
        ("cat <<'EOF'\n'\"\nEOF", "'\"\n"),
        ("echo $'closed\\''", "closed'\n"),
    ],
)
async def test_literal_quotes_are_not_reported_as_unclosed(command, expected):
    ws = Workspace({"/data": RAMVFS()})
    try:
        io = await ws.shell(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == expected
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("command", SIDE_EFFECT_COMMANDS)
async def test_a_missing_quote_refuses_before_any_command_runs(command):
    ws = Workspace({"/data": RAMVFS()})
    try:
        assert (await ws.shell(command)).exit_code == 2
        assert (await ws.shell("test -e /data/unexpected")).exit_code == 1
    finally:
        await ws.close()
