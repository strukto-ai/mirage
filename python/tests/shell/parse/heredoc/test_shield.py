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

from mirage.shell.parse.heredoc import (HeredocOperator, first_content_line,
                                        heredoc_operators, protected_source,
                                        same_shape, terminator_lookalikes)
from mirage.shell.parse.parse import TS_PARSER


def _root(command: str) -> tree_sitter.Node:
    return TS_PARSER.parse(command.encode()).root_node


def _diff(before: str, after: bytes) -> list[tuple[int, str]]:
    """The (offset, replacement) pairs by which ``after`` differs."""
    return [(i, chr(b)) for i, (a, b) in enumerate(zip(before.encode(), after))
            if a != b]


def test_heredoc_operators_reads_the_delimiter_as_bash_does():
    assert heredoc_operators(_root("cat <<-'EOF'\n\tbody\n\tEOF\n")) == [
        HeredocOperator(word_start=7,
                        word_end=12,
                        delimiter="EOF",
                        allows_indent=True)
    ]


def test_heredoc_operators_are_in_source_order():
    operators = heredoc_operators(_root("cat <<A\none\nA\ncat <<B\ntwo\nB\n"))
    assert [op.delimiter for op in operators] == ["A", "B"]


def test_heredoc_operators_finds_a_start_inside_an_error():
    # Two heredocs on one line are beyond the grammar, but both start
    # tokens survive the error.
    operators = heredoc_operators(_root("cat <<A ; cat <<B\none\nA\ntwo\nB\n"))
    assert [op.delimiter for op in operators] == ["A", "B"]


def test_first_content_line_skips_empty_lines():
    assert first_content_line(b"\n\nfoo\n", 0, 6) == 2


def test_first_content_line_counts_a_blank_line_as_content():
    assert first_content_line(b"  \nfoo\n", 0, 7) == 0


def test_first_content_line_is_none_for_empty_lines_only():
    assert first_content_line(b"\n\n", 0, 2) is None


def test_protected_source_is_none_when_the_body_lexes_already():
    cmd = "cat <<EOF\nfirst\nsecond\nEOF\n"
    assert protected_source(cmd.encode(), _root(cmd)) is None


def test_protected_source_masks_a_leading_backslash():
    cmd = "cat <<'EOF'\n\\first\nsecond\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\first"), "x")]


def test_protected_source_masks_the_escaped_partner_too():
    cmd = "cat <<EOF\n\\$v\nsecond\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    at = cmd.index("\\$v")
    assert _diff(cmd, out) == [(at, "x"), (at + 1, "x")]


def test_protected_source_masks_leading_indentation():
    cmd = "cat <<'EOF'\n  first\nsecond\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("  first"), "x")]


def test_protected_source_skips_empty_lines_before_the_first_content_line():
    cmd = "cat <<'EOF'\n\n\\first\nsecond\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\first"), "x")]


def test_protected_source_leaves_leading_empty_lines_to_body_prefix():
    cmd = "cat <<EOF\n\nfoo\nEOF\n"
    assert protected_source(cmd.encode(), _root(cmd)) is None


def test_protected_source_avoids_the_delimiters_first_letter():
    cmd = "cat <<xfirst\n\\first\nsecond\nxfirst\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\first"), "y")]


def test_protected_source_handles_every_heredoc_on_the_line_list():
    cmd = "cat <<A\n\\one\nA\ncat <<B\n\\two\nB\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\one"), "x"),
                               (cmd.index("\\two"), "x")]


def test_protected_source_shields_both_bodies_of_one_operator_line():
    # Laid out as the parser's source keeps two heredocs on one line:
    # innermost-first (see relayout), so B's body precedes A's.
    cmd = "cat <<A && cat <<B\n\\two\nB\n\\one\nA\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\two"), "x"),
                               (cmd.index("\\one"), "x")]


def test_protected_source_shields_an_escaped_double_quoted_delimiter():
    cmd = 'cat <<"E\\$F"\n\\first\nE$F\n'
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\first"), "x")]


def test_protected_source_ignores_an_operator_inside_a_body():
    # The swallowed first line spells `<<X`; body text is not syntax.
    cmd = "cat <<EOF\n\\a <<X\nsecond\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\a"), "x")]


def test_protected_source_dash_masks_the_leading_tab():
    cmd = "cat <<-'EOF'\n\t\\first\n\tsecond\n\tEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\t\\first"), "x")]


def test_protected_source_masks_an_unterminated_body_too():
    # Bash reads the body to the end of the input, so the shield does;
    # the masked copy still lacks heredoc_end, and _parse_bytes keeps
    # the plain tree for it.
    cmd = "cat <<EOF\n\\first\nsecond\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\\first"), "x")]


def test_terminator_lookalikes_names_one_byte_per_such_line():
    data = b"EOFX\nhi\n EOF\n\tEOF;\nEOF EOF\n"
    assert terminator_lookalikes(data, (0, len(data)), b"EOF") == [
        0,
        data.index(b" EOF") + 1,
        data.index(b"\tEOF;") + 1,
        data.index(b"EOF EOF"),
    ]


def test_terminator_lookalikes_passes_over_expansion_bytes():
    assert terminator_lookalikes(b"$X;\nhi\n", (0, 7), b"$X") == [1]
    assert terminator_lookalikes(b"$$\n", (0, 3), b"$") == []


def test_terminator_lookalikes_stays_inside_the_span():
    assert terminator_lookalikes(b"hi\nEOF\n", (0, 3), b"EOF") == []


def test_protected_source_masks_a_line_that_only_opens_with_the_delimiter():
    # The scanner compares a line's first bytes with the delimiter and
    # stops there, so each of these would end a body bash reads on.
    cmd = "cat <<EOF\nhi\nEOFX\nEOF;\n EOF\nEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("EOFX"), "x"),
                               (cmd.index("EOF;"), "x"),
                               (cmd.index(" EOF") + 1, "x")]


def test_protected_source_masks_a_lookalike_under_dash():
    # The first line's tab is masked as before; the lookalikes join it.
    cmd = "cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("\thi"), "x"),
                               (cmd.index("\tEOFX") + 1, "x"),
                               (cmd.index("  EOF") + 2, "x")]


def test_protected_source_keeps_an_expansion_opening_a_lookalike():
    cmd = "cat <<$X\n$X;\nhi\n$X\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("$X;") + 1, "x")]


def test_protected_source_writes_the_alternate_letter_over_the_filler():
    cmd = "cat <<xyz\nxyz1\nxyz\n"
    out = protected_source(cmd.encode(), _root(cmd))
    assert out is not None
    assert _diff(cmd, out) == [(cmd.index("xyz1"), "y")]


def test_same_shape_true_for_equal_parses():
    assert same_shape(_root("echo a | grep b"), _root("echo a | grep b"))


def test_same_shape_false_for_a_different_tree():
    assert not same_shape(_root("echo a | grep b"), _root("echo a; grep b"))


def test_same_shape_false_when_a_span_moves():
    assert not same_shape(_root("echo ab"), _root("echo abc"))
