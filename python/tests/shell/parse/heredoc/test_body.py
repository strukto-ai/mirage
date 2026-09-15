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

from mirage.shell.parse.heredoc import (HeredocOperator, clean_delimiter,
                                        heredoc_bodies, next_line,
                                        terminator_line)


def _operator(command: str, token: str, dash: bool = False) -> HeredocOperator:
    arrow = "<<-" if dash else "<<"
    word_start = command.index(arrow + token) + len(arrow)
    return HeredocOperator(word_start=word_start,
                           word_end=word_start + len(token),
                           delimiter=clean_delimiter(token),
                           allows_indent=dash)


def _bodies(command: str,
            *tokens: str,
            dash: bool = False,
            nested: bool = False):
    operators = [_operator(command, token, dash) for token in tokens]
    return heredoc_bodies(command.encode(), operators, nested=nested)


def test_terminator_line_is_the_first_line_equal_to_the_delimiter():
    assert terminator_line(b"body\nEOF\nEOF\n", 0, b"EOF", False) == 5


def test_terminator_line_without_a_trailing_newline():
    assert terminator_line(b"body\nEOF", 0, b"EOF", False) == 5


def test_terminator_line_dash_strips_tabs_not_spaces():
    assert terminator_line(b"\tbody\n\tEOF\n", 0, b"EOF", True) == 6
    assert terminator_line(b"  body\n  EOF\n", 0, b"EOF", True) is None


def test_terminator_line_requires_the_whole_line():
    assert terminator_line(b"EOFX\nEOF\n", 0, b"EOF", False) == 5


def test_terminator_line_missing_is_none():
    assert terminator_line(b"body\nmore\n", 0, b"EOF", False) is None


def test_next_line():
    assert next_line(b"a\nb", 0) == 2
    assert next_line(b"a\nb", 2) is None


def test_body_is_the_lines_between_the_operator_line_and_the_terminator():
    assert _bodies("cat <<EOF\nbody\nEOF\n", "EOF") == [(10, 15)]


def test_body_ends_at_a_terminator_without_a_trailing_newline():
    assert _bodies("cat <<EOF\nbody\nEOF", "EOF") == [(10, 15)]


def test_body_starts_after_a_pipeline_on_the_operator_line():
    cmd = "cat <<EOF | tr a-z A-Z\nbody\nEOF\n"
    assert _bodies(cmd, "EOF") == [(cmd.index("body"), cmd.rindex("EOF"))]


def test_body_starts_after_a_continued_operator_line():
    cmd = "cat <<EOF \\\n| tr a-z A-Z\nbody\nEOF\n"
    assert _bodies(cmd, "EOF") == [(cmd.index("body"), cmd.rindex("EOF"))]


def test_body_matches_the_unquoted_delimiter():
    cmd = "cat <<EN'D'\nbody\nEND\n"
    assert _bodies(cmd, "EN'D'") == [(cmd.index("body"), cmd.rindex("END"))]


def test_body_matches_an_escaped_double_quoted_delimiter():
    cmd = 'cat <<"E\\$F"\nbody\nE$F\n'
    assert _bodies(cmd, '"E\\$F"') == [(cmd.index("body"), cmd.rindex("E$F"))]


def test_dash_body_allows_a_tab_indented_terminator():
    cmd = "cat <<-EOF\n\tbody\n\tEOF\n"
    assert _bodies(cmd, "EOF",
                   dash=True) == [(cmd.index("\tbody"), cmd.index("\tEOF"))]


def test_dash_body_ignores_a_space_indented_terminator():
    # Only tabs are stripped, so the body runs on to the end.
    assert _bodies("cat <<-EOF\n  body\n  EOF\n", "EOF",
                   dash=True) == [(11, 24)]


def test_unterminated_body_runs_to_the_end_of_the_source():
    # Bash reads it that way too, under a warning naming the delimiter.
    assert _bodies("cat <<EOF\nbody\nmore\n", "EOF") == [(10, 20)]


def test_body_without_a_body_line_is_none():
    assert _bodies("cat <<EOF", "EOF") == [None]


def test_second_body_on_the_line_starts_after_the_first_terminator():
    assert _bodies("cat <<A <<B\none\nA\ntwo\nB\n", "A", "B") == [(12, 16),
                                                                  (18, 22)]


def test_bodies_keep_the_order_given():
    assert _bodies("cat <<A <<B\none\nA\ntwo\nB\n", "B", "A") == [(18, 22),
                                                                  (12, 16)]


def test_second_body_never_starts_when_the_first_runs_to_the_end():
    assert _bodies("cat <<A <<B\none\ntwo\nB\n", "A", "B") == [(12, 22), None]


def test_second_body_is_none_when_the_first_terminator_ends_the_source():
    assert _bodies("cat <<A <<B\none\nA", "A", "B") == [(12, 16), None]


def test_a_later_line_starts_its_own_body_after_its_own_operator_line():
    cmd = "cat <<A <<B\none\nA\ntwo\nB\ncat <<C\nthree\nC\n"
    assert _bodies(cmd, "A", "B",
                   "C") == [(12, 16), (18, 22),
                            (cmd.index("three"), cmd.rindex("C"))]


def test_operator_inside_an_earlier_body_is_text():
    cmd = "cat <<EOF\na <<X\nsecond\nEOF\n"
    assert _bodies(cmd, "EOF",
                   "X") == [(cmd.index("a <<X"), cmd.rindex("EOF")), None]


def test_dollar_quoted_delimiter_closes_its_own_body():
    # $'A' names A, so the first body ends at the A line and the second
    # operator still gets the lines after it.
    cmd = "cat <<$'A' <<'B'\nfirst\nA\n\\second\nB\n"
    assert _bodies(cmd, "$'A'",
                   "'B'") == [(cmd.index("first"), cmd.index("A\n")),
                              (cmd.index("\\second"), cmd.rindex("B"))]


def test_continued_delimiter_closes_its_own_body():
    # EO\<newline>F names EOF, so the body ends at the EOF line rather
    # than running to the end of the source.
    cmd = "cat <<EO\\\nF\nbody\nEOF\n"
    assert _bodies(cmd, "EO\\\nF") == [(cmd.index("body"), cmd.index("EOF\n"))]


def test_body_starts_after_a_multiline_parameter_expansion():
    cmd = "cat <<EOF >${x:-\n/out}\nbody\nEOF\n"
    assert _bodies(cmd, "EOF") == [(cmd.index("body"), cmd.index("EOF\n"))]


# ── nested order: the layout the parser's source keeps ─────────────────


def test_nested_reads_a_lines_bodies_innermost_first():
    command = "cat <<A && cat <<B\nb\nB\na\nA\n"
    b_start = command.index("\nb\n") + 1
    a_start = command.index("\na\n") + 1
    assert _bodies(command, "A", "B", nested=True) == [(a_start, a_start + 2),
                                                       (b_start, b_start + 2)]


def test_nested_and_bash_order_agree_on_a_single_heredoc_per_line():
    command = "cat <<A\na\nA\ncat <<B\nb\nB\n"
    assert _bodies(command, "A", "B",
                   nested=True) == _bodies(command, "A", "B")


def test_nested_still_treats_an_operator_inside_a_body_as_text():
    command = "cat <<A\ncat <<B\nA\nB\n"
    assert _bodies(command, "A", "B", nested=True) == [(8, 16), None]
