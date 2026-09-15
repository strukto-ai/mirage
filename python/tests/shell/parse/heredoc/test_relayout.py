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

from mirage.shell.parse import TS_PARSER
from mirage.shell.parse.heredoc import (Terminator, block_end, delimiter_break,
                                        line_terminators, relayout,
                                        word_breaks)


def _root(command: str) -> tree_sitter.Node:
    return TS_PARSER.parse(command.encode()).root_node


def _relaid(command: str) -> str | None:
    out = relayout(_root(command), command.encode())
    return None if out is None else out.decode()


def _terminators(line: str, after: str) -> list[Terminator]:
    data = line.encode()
    start = data.index(after.encode()) + len(after)
    return line_terminators(data, start, len(data))


# ── delimiter_break ─────────────────────────────────────────────────────


@pytest.mark.parametrize("token,expected", [
    ("EOF", None),
    ("EOF;", 3),
    ("EOF;echo", 3),
    ("EOF>out", 3),
    ("EOF|wc", 3),
    ("EOF&&echo", 3),
    ("EOF)", 3),
    ("'EOF'", None),
    ("'EOF;'", None),
    ('"EOF;"', None),
    ('"E\\";F"', None),
    ("E'O;'F;", 6),
    ("EO\\;F;", 5),
    ("$'EO;F';", 7),
    (";EOF", None),
])
def test_delimiter_break(token, expected):
    assert delimiter_break(token) == expected


def test_word_breaks_reports_where_the_blank_goes():
    assert word_breaks(_root("cat <<EOF; echo x\nhi\nEOF\n")) == [9]


def test_word_breaks_is_empty_for_a_whole_delimiter():
    assert word_breaks(_root("cat <<EOF\nhi\nEOF\n")) == []
    assert word_breaks(_root("cat <<'EOF'; echo x\nhi\nEOF\n")) == []


def test_word_breaks_counts_bytes_not_characters():
    command = "echo é; cat <<EOF;echo x\nhi\nEOF\n"
    assert word_breaks(_root(command)) == [command.encode().index(b"EOF;") + 3]


# ── line_terminators ────────────────────────────────────────────────────


def test_semicolon_resumes_past_the_token():
    assert _terminators("cat <<EOF ; echo x", "EOF") == [Terminator(10, 11)]


@pytest.mark.parametrize("line", [
    "cat <<EOF ;; esac",
    "cat <<EOF ;& esac",
    "cat <<EOF ;;& esac",
    "cat <<EOF ) ",
])
def test_kept_terminators_resume_at_the_token(line):
    assert _terminators(line, "EOF") == [Terminator(10, 10)]


def test_kept_terminators_are_read_longest_first():
    terms = _terminators("cat <<EOF ;;& x; y", "EOF")
    assert [t.start for t in terms] == [10, 15]


def test_quotes_constructs_and_comments_hide_their_terminators():
    line = "cat <<EOF 'a;b' \"c;d\" $(e;f) ${g;h} <(i;j) `k;l`"
    assert _terminators(line, "EOF") == []
    assert _terminators("cat <<EOF # a; b", "EOF") == []
    assert _terminators("cat <<EOF a\\;b; c", "EOF") == [Terminator(14, 15)]


def test_case_patterns_and_paren_groups_move_whole():
    line = "cat <<EOF; case y in y) echo;; esac; (a; b); ((i++)); z"
    starts = [t.start for t in _terminators(line, "EOF")]
    assert starts == [
        line.index("; case"),
        line.index(";; esac"),
        line.index("; (a"),
        line.index("; ((i"),
        line.index("; z"),
    ]


def test_an_unclosed_quote_ends_the_search():
    assert _terminators("cat <<EOF 'a; b", "EOF") == []


# ── relayout ────────────────────────────────────────────────────────────


def test_relayout_moves_a_semicolon_tail_past_the_body():
    assert (_relaid("cat <<EOF ; echo x\nhi\nEOF\n") ==
            "cat <<EOF \nhi\nEOF\n echo x\n")


def test_relayout_lays_a_lines_bodies_innermost_first():
    assert (_relaid("cat <<A && cat <<B\na\nA\nb\nB\n") ==
            "cat <<A && cat <<B\nb\nB\na\nA\n")
    assert (_relaid("cat <<A | cat <<B >o && cat <<C\na\nA\nb\nB\nc\nC\n") ==
            "cat <<A | cat <<B >o && cat <<C\nc\nC\nb\nB\na\nA\n")


def test_relayout_keeps_each_segments_bodies_with_it():
    assert (_relaid("cat <<A ; cat <<B ; echo c\na\nA\nb\nB\n") ==
            "cat <<A \na\nA\n cat <<B \nb\nB\n echo c\n")
    assert (_relaid("cat <<A && cat <<B ; echo c\na\nA\nb\nB\n") ==
            "cat <<A && cat <<B \nb\nB\na\nA\n echo c\n")


def test_relayout_cuts_only_at_the_first_terminator_after_an_operator():
    assert (_relaid("true; cat <<EOF ; echo x; echo y\nhi\nEOF\n") ==
            "true; cat <<EOF \nhi\nEOF\n echo x; echo y\n")


def test_relayout_keeps_case_and_paren_terminators_whole():
    assert _relaid("(cat <<EOF )\nhi\nEOF\n") == "(cat <<EOF \nhi\nEOF\n)\n"
    assert (_relaid("case x in x) cat <<EOF ;; esac\nhi\nEOF\n") ==
            "case x in x) cat <<EOF \nhi\nEOF\n;; esac\n")


def test_relayout_moves_a_comment_with_the_tail():
    assert (_relaid("cat <<EOF ; # a; b\nhi\nEOF\n") ==
            "cat <<EOF \nhi\nEOF\n # a; b\n")


def test_relayout_leaves_a_plain_heredoc_alone():
    assert _relaid("cat <<EOF\nhi\nEOF\n") is None
    assert _relaid("cat <<EOF && echo x\nhi\nEOF\n") is None
    assert _relaid("cat <<EOF\nhi\nEOF\necho x\n") is None


def test_relayout_leaves_an_unterminated_body_alone():
    assert _relaid("cat <<EOF ; echo x\nhi\n") is None


def test_relayout_adds_the_newline_a_last_terminator_lacks():
    assert _relaid(
        "cat <<EOF ; echo x\nhi\nEOF") == "cat <<EOF \nhi\nEOF\n echo x\n"


def test_relayout_keeps_the_lines_after_the_bodies():
    assert (_relaid("cat <<A ; echo x\na\nA\necho y\n") ==
            "cat <<A \na\nA\n echo x\necho y\n")


def test_relayout_handles_every_operator_line():
    assert (_relaid("cat <<A ; echo x\na\nA\ncat <<B ; echo y\nb\nB\n") ==
            "cat <<A \na\nA\n echo x\ncat <<B \nb\nB\n echo y\n")


def test_relayout_keeps_the_bodies_leading_empty_lines():
    assert (_relaid("cat <<A && cat <<B\n\na\nA\n\nb\nB\n") ==
            "cat <<A && cat <<B\n\nb\nB\n\na\nA\n")


def test_block_end_runs_past_the_terminator_line():
    assert block_end(b"cat <<A\na\nA\nx\n", (8, 10)) == 12
    assert block_end(b"cat <<A\na\nA", (8, 10)) == 11
