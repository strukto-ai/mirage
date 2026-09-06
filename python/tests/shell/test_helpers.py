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
import tree_sitter_bash

from mirage.shell.types import NodeType as NT
from mirage.shell.types import RedirectKind

from mirage.shell.helpers import (  # isort: skip
    brace_expands, byte_offset, get_case_items, get_case_word,
    get_command_name, get_declaration_keyword, get_for_parts,
    get_function_body, get_function_name, get_heredoc_meta, get_heredoc_parts,
    get_if_branches, get_list_parts, get_negated_command, get_parts,
    get_pipeline_commands, get_process_sub_body, get_redirects,
    get_subshell_body, get_text, get_while_parts, literal_word,
    split_env_prefix)

_LANG = tree_sitter.Language(tree_sitter_bash.language())
_PARSER = tree_sitter.Parser(_LANG)


def _parse(cmd: str):
    return _PARSER.parse(cmd.encode()).root_node


def _first(cmd: str):
    return _parse(cmd).children[0]


def test_get_command_name():
    assert get_command_name(_first("cat /data/file")) == "cat"


def test_get_command_name_with_assignment():
    assert get_command_name(_first("VAR=x echo hello")) == "echo"


def test_get_command_name_empty():
    assert get_command_name(_first("VAR=x")) == ""


def test_get_parts():
    parts = get_parts(_first("cat -n /data/file.txt"))
    texts = [get_text(p) for p in parts]
    assert texts == ["cat", "-n", "/data/file.txt"]


def test_get_parts_with_expansion():
    parts = get_parts(_first("echo $VAR"))
    assert len(parts) == 2
    assert parts[1].type == NT.SIMPLE_EXPANSION


def test_get_pipeline_commands():
    cmds, stderr = get_pipeline_commands(_first("echo a | grep b"))
    assert len(cmds) == 2
    assert stderr == [False]


def test_get_pipeline_commands_stderr():
    cmds, stderr = get_pipeline_commands(_first("echo a |& grep b"))
    assert len(cmds) == 2
    assert stderr == [True]


def test_get_pipeline_three():
    cmds, stderr = get_pipeline_commands(_first("a | b |& c"))
    assert len(cmds) == 3
    assert stderr == [False, True]


def test_get_while_parts():
    cond, body = get_while_parts(_first("while true; do echo loop; done"))
    assert get_text(cond) == "true"


def test_get_while_until():
    node = _first("until false; do echo; done")
    assert node.children[0].type == NT.UNTIL
    cond, body = get_while_parts(node)
    assert get_text(cond) == "false"


def test_get_for_parts():
    var, values, body = get_for_parts(_first("for f in a b c; do echo; done"))
    assert var == "f"
    assert [get_text(v) for v in values] == ["a", "b", "c"]


def test_get_for_select():
    node = _first("select f in x y; do echo; done")
    assert node.children[0].type == NT.SELECT
    var, values, body = get_for_parts(node)
    assert var == "f"
    assert [get_text(v) for v in values] == ["x", "y"]


def test_get_subshell_body():
    body = get_subshell_body(_first("(echo a; echo b)"))
    assert len(body) == 2


def test_get_list_parts_and():
    left, op, right = get_list_parts(_first("echo a && echo b"))
    assert op == "&&"


def test_get_list_parts_or():
    left, op, right = get_list_parts(_first("echo a || echo b"))
    assert op == "||"


def test_get_if_branches():
    branches, else_body = get_if_branches(
        _first("if true; then echo y; "
               "elif false; then echo n; "
               "else echo x; fi"))
    assert len(branches) == 2
    assert else_body is not None


def test_get_if_simple():
    branches, else_body = get_if_branches(_first("if true; then echo y; fi"))
    assert len(branches) == 1
    assert else_body is None


def test_get_case_word():
    node = _first("case $x in a) echo;; esac")
    word = get_case_word(node)
    assert word.type == NT.SIMPLE_EXPANSION


def test_get_case_items():
    items = get_case_items(_first("case x in a) echo a;; b) echo b;; esac"))
    assert len(items) == 2
    assert [get_text(p) for p in items[0][0]] == ["a"]
    assert [get_text(p) for p in items[1][0]] == ["b"]


def test_get_case_items_keeps_quoted_patterns_as_nodes():
    items = get_case_items(
        _first("case x in 'a'|\"b\"|$'c') echo q;; $p) echo v;; esac"))
    assert [p.type for p in items[0][0]
            ] == [NT.RAW_STRING, NT.STRING, NT.ANSI_C_STRING]
    assert [p.type for p in items[1][0]] == [NT.SIMPLE_EXPANSION]
    assert [len(item[1]) for item in items] == [1, 1]


def test_get_function_name():
    assert get_function_name(_first("f() { echo; }")) == "f"


def test_get_function_body():
    body = get_function_body(_first("f() { echo hello; }"))
    assert len(body) == 1


def test_get_function_body_rejects_non_function_node():
    with pytest.raises(ValueError, match="no compound body"):
        get_function_body(_first("echo hello"))


def test_get_command_name_no_args():
    assert get_command_name(_first("ls")) == "ls"


def test_get_parts_no_args():
    parts = get_parts(_first("ls"))
    assert len(parts) == 1
    assert get_text(parts[0]) == "ls"


def test_get_parts_excludes_redirect():
    parts = get_parts(_first("echo hello > out.txt").named_children[0])
    texts = [get_text(p) for p in parts]
    assert "out.txt" not in texts


def test_get_parts_drops_a_bare_zero_descriptor():
    stmt = _first("cat a 0>&-")
    parts = get_parts(stmt.named_children[0])
    assert [get_text(p) for p in parts] == ["cat", "a"]
    _, redirects = get_redirects(stmt)
    assert [(r.fd, r.target) for r in redirects] == [(0, -1)]
    spaced = _first("cat a 0 >&-")
    assert [get_text(p)
            for p in get_parts(spaced.named_children[0])] == ["cat", "a", "0"]
    assert [r.fd for r in get_redirects(spaced)[1]] == [1]
    _, chained = get_redirects(_first("cat 0<a >b"))
    assert [(r.fd, r.target) for r in chained] == [(0, "a"), (1, "b")]


def test_semicolon_is_program_level():
    """Semicolon creates separate commands, not a list node."""
    root = _parse("echo a; echo b")
    assert len(root.named_children) == 2
    assert root.named_children[0].type == NT.COMMAND
    assert root.named_children[1].type == NT.COMMAND


def test_get_if_multiple_elif():
    branches, else_body = get_if_branches(
        _first("if a; then b; elif c; then d; "
               "elif e; then f; else g; fi"))
    assert len(branches) == 3
    assert else_body is not None


def test_get_case_empty_body():
    items = get_case_items(_first("case x in a) ;; b) echo b;; esac"))
    assert len(items) == 2
    assert items[0][1] == []
    assert len(items[1][1]) == 1


def test_get_case_multi_statement_body():
    items = get_case_items(_first("case x in a) echo 1; echo 2;; esac"))
    assert len(items) == 1
    assert len(items[0][1]) == 2


def test_get_for_single_value():
    var, values, body = get_for_parts(_first("for x in hello; do echo; done"))
    assert var == "x"
    assert [get_text(v) for v in values] == ["hello"]


def test_get_for_with_expansion():
    var, values, body = get_for_parts(
        _first("for f in $DIR/*.txt; do echo; done"))
    assert var == "f"
    assert len(values) == 1
    assert values[0].type == NT.CONCATENATION


def test_get_while_body_type():
    cond, body = get_while_parts(_first("while true; do echo loop; done"))
    assert len(body) == 1
    assert body[0].type == NT.COMMAND


def test_background_detection():
    root = _parse("echo hello &")
    children = root.children
    has_bg = any(c.type == NT.BACKGROUND for c in children)
    assert has_bg


def test_process_substitution():
    node = _first("diff <(echo a) <(echo b)")
    parts = get_parts(node)
    ps_nodes = [p for p in parts if p.type == NT.PROCESS_SUBSTITUTION]
    assert len(ps_nodes) == 2


def test_heredoc():
    node = _first("cat <<EOF\nhello\nEOF")
    nc = node.named_children
    has_heredoc = any(c.type == NT.HEREDOC_REDIRECT for c in nc)
    assert has_heredoc


def test_get_pipeline_single():
    cmds, stderr = get_pipeline_commands(_first("echo a | grep b"))
    assert get_command_name(cmds[0]) == "echo"
    assert get_command_name(cmds[1]) == "grep"


def test_get_subshell_single():
    body = get_subshell_body(_first("(echo a)"))
    assert len(body) == 1


def test_export_keyword():
    assert get_declaration_keyword(_first("export A=1")) == "export"


def test_local_keyword():
    assert get_declaration_keyword(_first("local X=hello")) == "local"


# ── negated command ──────────────────────────────


def test_negated_command():
    node = _first("! echo hello")
    assert node.type == NT.NEGATED_COMMAND
    inner = get_negated_command(node)
    assert get_command_name(inner) == "echo"


# ── heredoc ──────────────────────────────────────


def test_heredoc_parts():
    node = _first("cat <<EOF\nhello\nworld\nEOF")
    redirect = node.named_children[1]
    delim, body = get_heredoc_parts(redirect)
    assert delim == "EOF"
    assert "hello" in body
    assert "world" in body


# ── process substitution ─────────────────────────


def test_process_sub_command():
    parts = get_parts(_first("diff <(echo a) <(echo b)"))
    ps_nodes = [p for p in parts if p.type == NT.PROCESS_SUBSTITUTION]
    assert len(ps_nodes) == 2
    inner = ps_nodes[0].named_children[0]
    assert get_command_name(inner) == "echo"


def test_process_sub_body_preserves_pipeline_and_list():
    pipeline = get_parts(_first("cat <(printf x | sort)"))[1]
    commands = get_parts(_first("cat <(echo one; echo two)"))[1]
    assert get_process_sub_body(pipeline) == "printf x | sort"
    assert get_process_sub_body(commands) == "echo one; echo two"


# ── expansion nodes ──────────────────────────────


def test_simple_expansion_in_parts():
    parts = get_parts(_first("echo $VAR"))
    assert parts[1].type == NT.SIMPLE_EXPANSION


def test_expansion_with_default():
    parts = get_parts(_first("echo ${VAR:-default}"))
    assert parts[1].type == NT.EXPANSION


def test_command_substitution_in_parts():
    parts = get_parts(_first("echo $(ls /data)"))
    assert parts[1].type == NT.COMMAND_SUBSTITUTION


def test_arithmetic_in_parts():
    parts = get_parts(_first("echo $((1 + 2))"))
    assert parts[1].type == NT.ARITHMETIC_EXPANSION


def test_concatenation_in_parts():
    parts = get_parts(_first("echo $DIR/file.txt"))
    assert parts[1].type == NT.CONCATENATION


def test_string_in_parts():
    parts = get_parts(_first('echo "hello $VAR"'))
    assert parts[1].type == NT.STRING


def test_raw_string_in_parts():
    parts = get_parts(_first("echo 'no expansion'"))
    assert parts[1].type == NT.RAW_STRING


# ── edge cases ───────────────────────────────────


def test_nested_command_substitution():
    parts = get_parts(_first("echo $(cat $(echo file))"))
    cs = parts[1]
    assert cs.type == NT.COMMAND_SUBSTITUTION
    inner_cmd = cs.named_children[0]
    inner_parts = get_parts(inner_cmd)
    assert inner_parts[1].type == NT.COMMAND_SUBSTITUTION


def test_mixed_expansion():
    parts = get_parts(_first("echo $DIR/$(cmd)/$((1+2))/*.txt"))
    assert parts[1].type == NT.CONCATENATION


def test_empty_command():
    root = _parse("")
    assert len(root.named_children) == 0


def test_redirect_with_pipe():
    node = _first("echo a | grep b > out.txt")
    assert node.type == NT.REDIRECTED_STATEMENT
    cmd, redirects = get_redirects(node)
    assert cmd.type == NT.PIPELINE
    assert redirects[0].target == "out.txt"


# ── quotes and escapes ──────────────────────────


def test_double_quoted_string():
    parts = get_parts(_first('echo "hello world"'))
    assert parts[1].type == NT.STRING


def test_single_quoted_raw():
    parts = get_parts(_first("echo 'no $expansion'"))
    assert parts[1].type == NT.RAW_STRING


def test_quoted_glob_not_expanded():
    """Glob inside quotes is string_content, not glob."""
    parts = get_parts(_first('echo "*.txt"'))
    assert parts[1].type == NT.STRING
    content = parts[1].named_children[0]
    assert content.type == NT.STRING_CONTENT
    assert get_text(content) == "*.txt"


def test_empty_string():
    parts = get_parts(_first('echo ""'))
    assert parts[1].type == NT.STRING
    assert len(parts[1].named_children) == 0


def test_single_in_double_quotes():
    parts = get_parts(_first("""echo "she said 'hi'" """))
    assert parts[1].type == NT.STRING
    assert "hi" in get_text(parts[1])


def test_mixed_quotes():
    parts = get_parts(_first("""echo "hello" 'world'"""))
    assert parts[1].type == NT.STRING
    assert parts[2].type == NT.RAW_STRING


def test_expansion_in_double_quotes():
    parts = get_parts(_first('echo "hello $VAR"'))
    assert parts[1].type == NT.STRING
    expansions = [
        c for c in parts[1].named_children if c.type == NT.SIMPLE_EXPANSION
    ]
    assert len(expansions) == 1


def test_no_expansion_in_single_quotes():
    parts = get_parts(_first("echo '$VAR'"))
    assert parts[1].type == NT.RAW_STRING


def test_backslash_in_word():
    parts = get_parts(_first("echo hello\\\\nworld"))
    assert "\\n" in get_text(parts[1])


# ── multi-statement bodies ─────────────────────


def test_for_multi_statement_body():
    _, values, body = get_for_parts(
        _first("for x in a; do echo 1; echo 2; echo 3; done"))
    assert len(body) == 3


def test_while_multi_statement_body():
    cond, body = get_while_parts(_first("while true; do echo a; echo b; done"))
    assert len(body) == 2


def test_if_multi_statement_then():
    branches, _ = get_if_branches(
        _first("if true; then echo a; echo b; echo c; fi"))
    assert len(branches) == 1
    cond, body = branches[0]
    assert len(body) == 3


def test_if_multi_statement_else():
    branches, else_body = get_if_branches(
        _first("if true; then echo a; else echo b; echo c; fi"))
    assert len(branches) == 1
    assert len(else_body) == 2


def test_if_multi_statement_elif():
    branches, else_body = get_if_branches(
        _first("if true; then echo a; "
               "elif false; then echo b; echo c; "
               "else echo d; fi"))
    assert len(branches) == 2
    assert len(branches[1][1]) == 2
    assert len(else_body) == 1


def test_function_multi_statement_body():
    body = get_function_body(_first("f() { echo a; echo b; echo c; }"))
    assert body is not None
    assert len(body) == 3


def test_function_single_statement_body():
    body = get_function_body(_first("f() { echo hello; }"))
    assert body is not None
    assert len(body) == 1


def test_select_multi_statement_body():
    node = _first("select f in a b; do echo 1; echo 2; done")
    _, _, body = get_for_parts(node)
    assert len(body) == 2


# ── redirect target types ──────────────────────


def test_redirect_target_concat():
    node = _first("echo x > $DIR/out.txt")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.CONCATENATION


def test_redirect_target_expansion():
    node = _first("echo x > $OUT")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.SIMPLE_EXPANSION


def test_redirect_target_cmd_sub():
    node = _first("echo x > $(echo out.txt)")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.COMMAND_SUBSTITUTION


def test_redirect_target_heredoc_carries_node():
    # The heredoc_redirect node rides along so the expansion layer can
    # walk the body's expansion children structurally.
    node = _first("cat <<EOF\nhello\nEOF")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == "heredoc_redirect"


def test_redirect_target_stderr():
    node = _first("cmd 2> /err.txt")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert get_text(target_node) == "/err.txt"


def test_redirect_target_raw_string():
    # Single quotes parse as raw_string; the node must ride along or the
    # expansion layer sees target_node None and falls back to the empty
    # target, silently writing nowhere.
    node = _first("echo x > '/out.txt'")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.RAW_STRING


def test_redirect_target_double_quoted_string():
    node = _first('echo x > "/out.txt"')
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.STRING


def test_redirect_target_unquoted_word():
    node = _first("echo x > /out.txt")
    _, redirects = get_redirects(node)
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.WORD


@pytest.mark.parametrize(
    "cmd", ["echo x > '/out.txt'", 'echo x > "/out.txt"', "echo x > /out.txt"])
def test_redirect_target_carried_for_every_quoting_form(cmd: str):
    # Quoting a redirect target is purely syntactic in bash: all three
    # forms must reach the expansion layer with a target node.
    _, redirects = get_redirects(_first(cmd))
    assert redirects[0].target_node is not None


@pytest.mark.parametrize("cmd", [
    "echo x >> '/out.txt'",
    "cmd 2> '/err.txt'",
    "cmd < '/in.txt'",
    "cmd &> '/both.txt'",
])
def test_redirect_raw_string_target_all_operators(cmd: str):
    # Every operator shares _parse_file_redirect, so a single-quoted
    # target has to survive on all of them, not just plain `>`.
    _, redirects = get_redirects(_first(cmd))
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == NT.RAW_STRING


def test_herestring_raw_string_target():
    # `<<< 'text'` shares the same target-type gate as file redirects.
    node = _first("cat <<< 'hi' > out.txt")
    _, redirects = get_redirects(node)
    herestring = [r for r in redirects if r.kind == RedirectKind.HERESTRING]
    assert len(herestring) == 1
    target_node = herestring[0].target_node
    assert target_node is not None
    assert target_node.type == NT.RAW_STRING


@pytest.mark.parametrize("cmd,expected_type", [
    ("echo x > $'/out 1.txt'", NT.ANSI_C_STRING),
    ('echo x > $"/out.txt"', NT.TRANSLATED_STRING),
    ("cmd 2>> $'/e.log'", NT.ANSI_C_STRING),
])
def test_redirect_dollar_quoted_targets_ride_along(cmd: str,
                                                   expected_type: NT):
    # $'...' and $"..." are quoting forms like '...' and "...": a
    # redirect target in either must reach the expansion layer.
    _, redirects = get_redirects(_first(cmd))
    target_node = redirects[0].target_node
    assert target_node is not None
    assert target_node.type == expected_type


def test_herestring_ansi_c_target():
    node = _first("cat <<< $'a\\tb' > out.txt")
    _, redirects = get_redirects(node)
    herestring = [r for r in redirects if r.kind == RedirectKind.HERESTRING]
    assert len(herestring) == 1
    target_node = herestring[0].target_node
    assert target_node is not None
    assert target_node.type == NT.ANSI_C_STRING


# ── python command parsing ─────────────────────


def test_python3_c_flag():
    cmd = _first('python3 -c "print(1)"')
    assert get_command_name(cmd) == "python3"
    parts = get_parts(cmd)
    assert get_text(parts[1]) == "-c"
    assert parts[2].type == NT.STRING


def test_python3_script_path():
    cmd = _first("python3 /data/script.py")
    assert get_command_name(cmd) == "python3"
    parts = get_parts(cmd)
    assert get_text(parts[1]) == "/data/script.py"


def test_python3_with_args():
    cmd = _first("python3 /data/script.py arg1 arg2")
    parts = get_parts(cmd)
    assert len(parts) == 4
    assert get_text(parts[2]) == "arg1"
    assert get_text(parts[3]) == "arg2"


def test_python3_heredoc():
    node = _first("python3 <<PYEOF\nprint('hello')\nPYEOF")
    assert node.type == NT.REDIRECTED_STATEMENT
    cmd, _ = get_redirects(node)
    assert get_command_name(cmd) == "python3"
    redirect = node.named_children[1]
    assert redirect.type == NT.HEREDOC_REDIRECT
    delim, body = get_heredoc_parts(redirect)
    assert delim == "PYEOF"
    assert "print" in body


def test_python3_heredoc_quoted_delim():
    node = _first("python3 <<'SCRIPT'\nprint('hi')\nSCRIPT")
    redirect = node.named_children[1]
    delim, body = get_heredoc_parts(redirect)
    assert "SCRIPT" in delim
    assert "print" in body


def test_python3_heredoc_double_quoted():
    node = _first('python3 <<"EOF"\nimport sys\nEOF')
    redirect = node.named_children[1]
    delim, body = get_heredoc_parts(redirect)
    assert "EOF" in delim
    assert "import sys" in body


def test_python_command_name():
    cmd = _first("python script.py")
    assert get_command_name(cmd) == "python"


def test_python3_c_with_expansion():
    cmd = _first('python3 -c "print($VAR)"')
    parts = get_parts(cmd)
    string_node = parts[2]
    assert string_node.type == NT.STRING
    expansions = [
        c for c in string_node.named_children if c.type == NT.SIMPLE_EXPANSION
    ]
    assert len(expansions) == 1


def test_get_redirects_bare_redirect_has_no_command():
    node = _first("> empty.txt")
    command, redirects = get_redirects(node)
    assert command is None
    assert len(redirects) == 1
    assert redirects[0].target == "empty.txt"


def test_get_redirects_hoists_file_redirect_inside_heredoc():
    # `cat <<END > out.txt` parses the file redirect INSIDE the
    # heredoc_redirect node; it must surface as a sibling redirect.
    node = _first("cat <<END > out.txt\nbody\nEND")
    command, redirects = get_redirects(node)
    assert command is not None
    kinds = [r.kind for r in redirects]
    assert RedirectKind.HEREDOC in kinds
    assert RedirectKind.STDOUT in kinds
    stdout_r = [r for r in redirects if r.kind == RedirectKind.STDOUT][0]
    assert stdout_r.target == "out.txt"


def test_get_redirects_hoists_herestring_before_file_redirect():
    node = _first("cat <<< here < input.txt")
    _, redirects = get_redirects(node)
    assert [r.kind for r in redirects
            ] == [RedirectKind.HERESTRING, RedirectKind.STDIN]


def test_get_redirects_recovers_herestring_after_file_redirect():
    node = _first("cat < input.txt <<< here")
    _, redirects = get_redirects(node)
    assert [r.kind for r in redirects
            ] == [RedirectKind.STDIN, RedirectKind.HERESTRING]
    assert redirects[1].target == "here"


def test_get_heredoc_meta_partially_quoted_delimiter():
    node = _first("cat <<EN'D'\nx=$v\nEND\n")
    heredoc = None
    for c in node.named_children:
        if c.type == NT.HEREDOC_REDIRECT:
            heredoc = c
    assert heredoc is not None
    body, dash, quoted = get_heredoc_meta(heredoc)
    assert quoted is True
    assert dash is False
    assert body == "x=$v\n"


def test_get_heredoc_meta_backslash_quoted_delimiter():
    node = _first("cat <<\\END\nx=$v\nEND\n")
    heredoc = node.named_children[1]
    body, dash, quoted = get_heredoc_meta(heredoc)
    assert quoted is True
    assert dash is False
    assert body == "x=$v\n"


def test_get_heredoc_meta_body_gets_trailing_newline():
    # tree-sitter drops the final newline for concatenated delimiters.
    node = _first("cat <<EN'D'\nline\nEND\n")
    heredoc = node.named_children[1]
    body, _, _ = get_heredoc_meta(heredoc)
    assert body == "line\n"


def _literals(line: str, home: str | None = None) -> list[str | None]:
    _, parts = split_env_prefix(get_parts(_first(line)))
    return [literal_word(p, home) for p in parts]


@pytest.mark.parametrize(
    "line, expected",
    [
        # Plain, quoted and escaped words read as the text they name.
        ("rm x", ["rm", "x"]),
        ("'rm' \"/a b\" c", ["rm", "/a b", "c"]),
        ("\\rm a\"b\"c \"a\\\"b\"", ["rm", "abc", 'a"b']),
        ("$'x\\ty' $\"hi\" 3", ["x\ty", "hi", "3"]),
        ("echo $ /a*", ["echo", "$", "/a*"]),
        # A word only the runtime can expand reads as None, wherever it
        # sits and however it is quoted or joined.
        ("$cmd /x", [None, "/x"]),
        ("\"$cmd\" x", [None, "x"]),
        ("${cmd} a$b", [None, None]),
        ("eval \"$P\"", ["eval", None]),
        ("cat \"$d\"/x --f=\"$v\"", ["cat", None, None]),
        ("rm $((1+2)) $(date) <(ls)", ["rm", None, None, None]),
        # Brace expansion multiplies words, so it is not literal either;
        # a lone {} and a quoted brace are.
        ("rm /r/{a,b} x{1..3} {} '{a,b}'", ["rm", None, None, "{}", "{a,b}"]),
    ])
def test_literal_word_reads_what_a_word_names_before_expansion(line, expected):
    assert _literals(line) == expected


def test_literal_word_expands_a_leading_unquoted_tilde_only():
    assert _literals("ls ~ ~/x \"~/y\" ~u a~ ~/x\"y\"", "/home/me") == [
        "ls", "/home/me", "/home/me/x", "~/y", "~u", "a~", "/home/me/xy"
    ]
    # No $HOME: the tilde stays, as in bash.
    assert _literals("ls ~/x") == ["ls", "~/x"]


def test_brace_expands():
    assert brace_expands("{a,b}") and brace_expands("x{1..3}y")
    assert brace_expands("{a,{b,c}}")
    assert not brace_expands("{}") and not brace_expands("{abc}")
    assert not brace_expands("a,b") and not brace_expands("{a,b")


def test_byte_offset_counts_the_bytes_before_an_index():
    assert byte_offset("cat é x", 4) == 4
    assert byte_offset("cat é x", 5) == 6
    assert byte_offset("cat é x", 7) == 8
    assert byte_offset("", 0) == 0
