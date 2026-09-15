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

from typing import cast

import tree_sitter

from mirage.shell.parse.heredoc import body_prefix, tree_root
from mirage.shell.parse.parse import TS_PARSER, _parse_bytes

HEREDOC_REDIRECT = "heredoc_redirect"


def _redirects(root: tree_sitter.Node) -> list[tree_sitter.Node]:
    found: list[tree_sitter.Node] = []
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == HEREDOC_REDIRECT:
            found.append(node)
        stack.extend(node.children)
    if not found:
        raise AssertionError("no heredoc_redirect in the tree")
    return sorted(found, key=lambda node: node.start_byte)


def _prefix(command: str) -> str:
    return body_prefix(_redirects(_parse_bytes(command.encode()))[0])


class _Node:
    """The slice of a tree_sitter.Node that body_prefix reads."""

    def __init__(self,
                 type_: str,
                 start: int,
                 end: int,
                 source: bytes,
                 children: "list[_Node] | None" = None):
        self.type = type_
        self.start_byte = start
        self.end_byte = end
        self.text = source[start:end]
        self.children = children or []
        self.parent: _Node | None = None
        self.prev_sibling: _Node | None = None
        previous: _Node | None = None
        for child in self.children:
            child.parent = self
            child.prev_sibling = previous
            previous = child


# Two heredocs on one line, laid out as the parser's source keeps them:
# innermost-first (see relayout), so B's body precedes A's.
TWO_ON_A_LINE = b"cat <<A <<B\nb\nB\n\na\nA\n"


def _heredoc(operator: int, body: int) -> _Node:
    """A redirect of TWO_ON_A_LINE: ``<<`` at ``operator``, a one-letter
    delimiter, and a one-letter body line at ``body``."""
    return _Node(HEREDOC_REDIRECT, operator, body + 3, TWO_ON_A_LINE, [
        _Node("<<", operator, operator + 2, TWO_ON_A_LINE),
        _Node("heredoc_start", operator + 2, operator + 3, TWO_ON_A_LINE),
        _Node("heredoc_body", body, body + 2, TWO_ON_A_LINE),
        _Node("heredoc_end", body + 2, body + 3, TWO_ON_A_LINE),
    ])


def test_body_prefix_is_empty_when_the_node_starts_the_body():
    assert _prefix("cat <<EOF\nfoo\nEOF\n") == ""


def test_body_prefix_is_the_leading_empty_line():
    assert _prefix("cat <<EOF\n\nfoo\nEOF\n") == "\n"


def test_body_prefix_is_every_leading_empty_line():
    assert _prefix("cat <<EOF\n\n\nfoo\nEOF\n") == "\n\n"


def test_body_prefix_before_a_backslash_line():
    assert _prefix("cat <<EOF\n\n\\first\nEOF\n") == "\n"


def test_body_prefix_of_a_body_that_is_one_empty_line():
    assert _prefix("cat <<EOF\n\nEOF\n") == "\n"


def test_body_prefix_after_a_pipeline_on_the_operator_line():
    assert _prefix("cat <<EOF | tr a-z A-Z\n\nfoo\nEOF\n") == "\n"


def test_body_prefix_after_a_comment_on_the_operator_line():
    assert _prefix("cat <<EOF # don't\n\nfoo\nEOF\n") == "\n"


def test_body_prefix_after_a_file_redirect():
    assert _prefix("cat > /data/x <<EOF\n\nfoo\nEOF\n") == "\n"


def test_body_prefix_under_dash():
    assert _prefix("cat <<-EOF\n\n\tfoo\nEOF\n") == "\n"


def test_body_prefix_leaves_a_blank_first_line_to_the_body():
    assert _prefix("cat <<EOF\n  \nfoo\nEOF\n") == ""


def test_body_prefix_is_the_indentation_an_unshielded_tree_skipped():
    cmd = "cat <<EOF\n  foo\nEOF\n"
    root = TS_PARSER.parse(cmd.encode()).root_node
    assert body_prefix(_redirects(root)[0]) == "  "


def test_body_prefix_when_blanks_precede_the_command():
    # The tree's root starts past them, so the source is read from there.
    assert _prefix("  cat <<EOF\n\nfoo\nEOF\n") == "\n"
    assert _prefix("\n\ncat <<EOF\n\nfoo\nEOF\n") == "\n"


def test_body_prefix_of_an_unterminated_body():
    # Bash reads the body to the end of the input, blank lines included.
    assert _prefix("cat <<EOF\n\nfoo\n") == "\n"


def test_body_prefix_of_a_heredoc_inside_a_command_substitution():
    outer, inner = _redirects(
        _parse_bytes(b"cat <<A $(cat <<B\n\nb\nB\n)\na\nA\n"))
    assert body_prefix(outer) == ""
    assert body_prefix(inner) == "\n"


def test_body_prefix_of_an_earlier_heredoc_on_the_line():
    # tree-sitter-bash has no tree for two heredocs on one command; were
    # it to grow one, the line's bodies would stand innermost-first as
    # relayout writes them, so B's body follows the operator line and
    # A's blank line is measured from the line after B's terminator, not
    # from the operator line's newline the two share.
    first = _heredoc(4, 17)
    second = _heredoc(8, 12)
    root = _Node("program", 0, len(TWO_ON_A_LINE), TWO_ON_A_LINE, [
        _Node("redirected_statement", 0, 20, TWO_ON_A_LINE,
              [_Node("command", 0, 3, TWO_ON_A_LINE), first, second])
    ])
    assert tree_root(cast(tree_sitter.Node, second)) is root
    assert body_prefix(cast(tree_sitter.Node, second)) == ""
    assert body_prefix(cast(tree_sitter.Node, first)) == "\n"
