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

import tree_sitter

from mirage.shell import parse
from mirage.shell.helpers import (get_command_name, get_for_parts,
                                  get_if_branches, get_list_parts, get_parts,
                                  get_pipeline_commands, get_redirects,
                                  get_text, get_while_parts)
from mirage.shell.parse import find_syntax_error
from mirage.shell.types import NodeType as NT


def test_parse_returns_node():
    root = parse("echo hello")
    assert isinstance(root, tree_sitter.Node)


def test_parse_root_is_program():
    root = parse("echo hello")
    assert root.type == "program"


def test_simple_command():
    root = parse("echo hello")
    cmd = root.named_children[0]
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


def test_partial_quoted_heredoc_end_is_not_syntax_error():
    root = parse("cat <<EN'D'\n$v\nEND")
    assert find_syntax_error(root) is None


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
