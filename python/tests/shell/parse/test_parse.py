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
from mirage.shell.helpers import (get_command_name, get_for_parts,
                                  get_if_branches, get_list_parts, get_parts,
                                  get_pipeline_commands, get_redirects,
                                  get_text, get_while_parts)
from mirage.shell.parse import strip_line_continuation
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
    node = parse("if true; then echo a; elif false; then echo b; "
                 "else echo c; fi").named_children[0]
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
    cond, body = get_while_parts(node)
    assert get_text(cond) == "true"


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
    cmd = parse('echo "hello" \'world\'').named_children[0]
    types = [c.type for c in cmd.named_children if c.type != NT.COMMAND_NAME]
    assert NT.STRING in types
    assert NT.RAW_STRING in types


def test_complex_command():
    root = parse("for f in $(ls /data/); do "
                 "cat $f | grep error > /out/$f; done")
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


# ── `((` reparse: subshell that immediately opens a subshell ────────


def test_double_open_paren_parses_as_nested_subshells():
    """``((`` lexes as the arithmetic opener; bash reparses, so do we."""
    node = parse("((echo a); echo b)").named_children[0]
    assert node.type == NT.SUBSHELL


def test_double_open_paren_backgrounded():
    assert not parse("((echo s1; echo s2) & wait)").has_error


def test_genuine_arithmetic_command_is_untouched():
    assert not parse("i=1; ((i++)); echo $i").has_error


def test_line_mixing_arithmetic_and_nested_subshell():
    """Each opener is judged on its own span, not on the error region.

    tree-sitter's ERROR swallows the valid ``((i++))`` next to the bad
    opener, so scope alone would split both and silently turn the
    arithmetic into a subshell running ``i++``.
    """
    assert not parse("i=1; ((i++)); ((echo x); echo $i)").has_error


def test_paren_inside_quotes_does_not_confuse_the_scan():
    assert not parse('((echo ")"); echo b)').has_error


def test_two_nested_subshells_on_one_line():
    assert not parse("((echo a); echo b); ((echo c); echo d)").has_error


def test_multibyte_text_before_the_opener_does_not_shift_offsets():
    """tree-sitter reports byte offsets; ``é`` is two bytes in UTF-8."""
    assert not parse("echo é; ((echo a); echo b)").has_error


def test_unrelated_syntax_error_still_reports():
    assert parse("if then").has_error


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
    ])
def test_strip_line_continuation(command, expected):
    assert strip_line_continuation(command) == expected


# tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
# when the name is cut short by a name-terminating character: the `$`
# stays behind as a literal token and the rest splits into a sibling
# word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
# the orphaned expansion and reparses, so consumers see one whole word.
@pytest.mark.parametrize(("command", "target"), [
    ("echo hi > /api/$c/$id.json", "/api/$c/${id}.json"),
    ("echo hi > /api/$c/$id-x", "/api/$c/${id}-x"),
    ("echo hi > /w/$a/$b/$c", "/w/$a/${b}/$c"),
    ("echo hi > ${a}.$b.json", "${a}.${b}.json"),
    ("echo hi > /w/$c/$1.json", "/w/$c/${1}.json"),
])
def test_redirect_target_later_unbraced_var_stays_one_word(command, target):
    node = parse(command).named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    _, redirects = get_redirects(node)
    assert len(redirects) == 1
    assert redirects[0].target == target


def test_word_later_unbraced_var_stays_one_argument():
    cmd = parse("echo /api/$c/$id.json").named_children[0]
    parts = get_parts(cmd)
    assert [get_text(p) for p in parts] == ["echo", "/api/$c/${id}.json"]


def test_assignment_later_unbraced_var_stays_one_assignment():
    # The broken parse split this into an assignment holding
    # `p=/api/$c/$` plus a command named `id.json`.
    node = parse("p=/api/$c/$id.json").named_children[0]
    assert node.type == NT.VARIABLE_ASSIGNMENT
    assert get_text(node) == "p=/api/$c/${id}.json"


@pytest.mark.parametrize(
    ("command", "words"),
    [
        # A `$` bash keeps literal is left alone: no name character follows.
        ("echo a$ b", ["echo", "a$", "b"]),
        ("echo $", ["echo", "$"]),
    ])
def test_literal_dollar_words_stay_untouched(command, words):
    cmd = parse(command).named_children[0]
    assert [get_text(p) for p in get_parts(cmd)] == words


@pytest.mark.parametrize("command, body", [
    ("cat <<'EOF'\n\\first\nsecond\nEOF", "\\first\nsecond\n"),
    ("cat <<'EOF'\n\\first\n\\second\nthird\nEOF",
     "\\first\n\\second\nthird\n"),
    ("cat <<'EOF'\n  first\nsecond\nEOF", "  first\nsecond\n"),
    ("cat <<'EOF'\n\\begin{table}\n  \\begin{center}\nEOF",
     "\\begin{table}\n  \\begin{center}\n"),
    ("cat <<'EOF'\n\\item Don't\nsecond\nEOF", "\\item Don't\nsecond\n"),
    ('cat <<"E\\$F"\n\\first\nE$F', "\\first\n"),
])
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
@pytest.mark.parametrize("command", [
    'cat <<EOF; echo x\nhi\nEOF\n', 'cat <<EOF;echo x\nhi\nEOF\n',
    'cat <<EOF>out\nhi\nEOF\n', 'cat <<EOF|wc -l\nhi\nEOF\n',
    'cat <<EOF&&echo x\nhi\nEOF\n', "cat <<'EOF'; echo x\nhi\nEOF\n",
    'cat <<EOF;\nhi\nEOF;\nEOF\n', '(cat <<EOF)\nhi\nEOF)\nEOF\n',
    'cat <<A && cat <<B\na\nA\nb\nB\n', 'cat <<A; cat <<B\na\nA\nb\nB\n',
    '(cat <<EOF)\nhi\nEOF\n', 'case x in x) cat <<EOF;; esac\nhi\nEOF\n',
    '{ cat <<EOF; }\nhi\nEOF\n'
])
def test_heredoc_operator_line_preserves_original_source(command):
    root = parse(command)
    assert not root.has_error
    assert root.source_text.decode() == command


def test_two_heredocs_on_one_line_keep_their_own_bodies():
    assert _heredoc_bodies_by_delimiter(
        "cat <<A && cat <<B\na\nA\nb\nB\n") == {
            "A": "a\n",
            "B": "b\n",
        }
    assert _heredoc_bodies_by_delimiter(
        "cat <<A | cat <<B; cat <<C\na\nA\nb\nB\nc\nC\n") == {
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
        "cat <<EOF; echo x\nhi\nEOF;\nEOF\n") == {
            "EOF": "hi\nEOF;\n",
        }
    assert _heredoc_bodies_by_delimiter(
        "cat <<EOF|tr a-z A-Z\nhi\nEOF|tr a-z A-Z\nEOF\n") == {
            "EOF": "hi\nEOF|tr a-z A-Z\n",
        }


def test_heredoc_body_keeps_a_line_that_only_opens_with_the_delimiter():
    # tree-sitter-bash's scanner compares a line's first bytes with the
    # delimiter and stops there; bash wants the whole line.
    assert _heredoc_bodies_by_delimiter(
        "cat <<EOF\nEOFX\nEOF;\n EOF\nEOF\n") == {
            "EOF": "EOFX\nEOF;\n EOF\n",
        }
    assert _heredoc_bodies_by_delimiter(
        "cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n") == {
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
