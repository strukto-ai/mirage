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

import re

import pytest

from mirage.commands.builtin.generic.rg import parse_flags, rg_matcher
from mirage.commands.builtin.rg_search import (ByteCursor, NonmatchStop,
                                               RgFlags, Tally, expand,
                                               replace_all, rust_matches,
                                               search_haystack,
                                               smart_case_folds)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView


def _flags(**flags) -> RgFlags:
    return parse_flags(FlagView(flags, spec=SPECS["rg"]))


async def _source(data: bytes):
    yield data


async def _search(data: bytes,
                  pattern: str,
                  label: str | None = None,
                  **flags) -> tuple[str, bool]:
    f = _flags(**flags)
    tally = Tally()
    chunks = [
        c async for c in search_haystack(_source(
            data), rg_matcher(pattern, False, f), f, "f", label, tally)
    ]
    return b"".join(chunks).decode(), tally.selected


def test_rust_matches_skip_the_empty_match_a_match_ends_at():
    # `b*` over `abc` is empty, `b`, empty: finditer also yields the
    # empty match right after `b`.
    spans = [m.span() for m in rust_matches(re.compile("b*"), "abc")]
    assert spans == [(0, 0), (1, 2), (3, 3)]


@pytest.mark.parametrize("template, want", [
    ("<$1>", "<b>"),
    ("<${1}>", "<b>"),
    ("<$name>", "<b>"),
    ("<$1x>", "<>"),
    ("<$$>", "<$>"),
    ("<$>", "<$>"),
    ("<$9>", "<>"),
])
def test_expand_reads_groups_as_rusts_captures_expand(template, want):
    m = re.search("a(?P<name>b)", "ab")
    assert m is not None
    assert expand(template, m) == want


def test_replace_all_reports_where_each_replacement_landed():
    text, spans = replace_all(re.compile("o"), "foo", "XY")
    assert (text, spans) == ("fXYXY", [(1, 3), (3, 5)])


@pytest.mark.parametrize("pattern, fixed, folds", [
    ("hello", False, True),
    ("Hello", False, False),
    (r"\w+", False, False),
    (r"\Whello", False, True),
    ("[A-Z]", False, False),
    ("a{2}", False, True),
    (r"\x41", False, False),
    ("H.llo", True, False),
])
def test_smart_case_folds_only_an_all_lowercase_pattern(pattern, fixed, folds):
    assert smart_case_folds(pattern, fixed) is folds


def test_byte_cursor_counts_each_step_from_the_last():
    cursor = ByteCursor("café abc abc")
    assert [cursor.at(5), cursor.at(9)] == [6, 10]


def test_nonmatch_stop_arms_after_the_first_selection():
    stop = NonmatchStop(True, False)
    assert not stop.armed
    stop.select()
    assert stop.armed


def test_an_inverted_nonmatch_stop_passes_one_line_over():
    stop = NonmatchStop(True, True)
    assert not stop.passes_over()
    stop.select()
    assert stop.passes_over() and stop.armed
    assert not stop.passes_over()


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, want", [
    ({}, "a1\na2\n"),
    ({
        "after_context": "1"
    }, "a1\na2\nb\n"),
    ({
        "count": True
    }, "2\n"),
    ({
        "passthru": True
    }, "a1\na2\nb\n"),
    ({
        "invert_match": True
    }, "b\nc\n"),
])
async def test_stop_on_nonmatch_ends_the_file_where_ripgrep_does(flags, want):
    # ripgrep 14.1.1 over `a1 a2 b a3 c` with --stop-on-nonmatch.
    out, _ = await _search(b"a1\na2\nb\na3\nc\n",
                           "a",
                           stop_on_nonmatch=True,
                           **flags)
    assert out == want


@pytest.mark.asyncio
async def test_whole_word_uses_half_boundaries():
    # ripgrep 14.1.1: -w is \b{start-half}...\b{end-half}, so `-foo`
    # matches after a space, which \b-foo\b never does.
    out, _ = await _search(b"a -foo b\nx-foo\n", "-foo", word_regexp=True)
    assert out == "a -foo b\n"


@pytest.mark.asyncio
async def test_the_later_of_w_and_x_bounds_the_pattern():
    data = b"hello there\nhello\n"
    out, _ = await _search(data, "hello", line_regexp=True, word_regexp=True)
    assert out == "hello there\nhello\n"
    out, _ = await _search(data, "hello", word_regexp=True, line_regexp=True)
    assert out == "hello\n"


@pytest.mark.asyncio
async def test_vimgrep_prints_a_record_per_match_with_its_column():
    out, _ = await _search(b"ab ab\n", "ab", "/m", vimgrep=True)
    assert out == "/m:1:1:ab ab\n/m:1:4:ab ab\n"
    out, _ = await _search(b"ab ab\n",
                           "ab",
                           "/m",
                           vimgrep=True,
                           no_column=True)
    assert out == "/m:1:ab ab\n/m:1:ab ab\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, want", [
    ({
        "max_columns": "3"
    }, "[Omitted long matching line]\n"),
    ({
        "max_columns": "3",
        "column": True
    }, "1:1:[Omitted long line with 2 matches]\n"),
    ({
        "max_columns": "3",
        "max_columns_preview": True
    }, "ab  [... omitted end of long line]\n"),
])
async def test_max_columns_words_what_it_left_out(flags, want):
    out, _ = await _search(b"ab ab\n", "ab", **flags)
    assert out == want


@pytest.mark.asyncio
async def test_only_matching_offsets_count_bytes():
    out, _ = await _search("café abc abc\n".encode(),
                           "abc",
                           only_matching=True,
                           byte_offset=True)
    assert out == "6:abc\n10:abc\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, expected", [
    ({
        "line_number": True,
        "byte_offset": True
    }, "1:0:a\0"
     "5:8:a\0"),
    ({
        "count": True
    }, "2\0"),
    ({
        "files_with_matches": True
    }, "f\0"),
    ({
        "after_context": "1"
    }, "a\0b\0--\0a\0"),
    ({
        "only_matching": True
    }, "a\0a\0"),
    ({
        "max_count": "1"
    }, "a\0"),
])
async def test_null_data_records(flags, expected):
    actual, selected = await _search(b"a\0b\0c\0d\0a",
                                     "a",
                                     null_data=True,
                                     **flags)
    assert actual == expected
    assert selected


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{}, {"line_regexp": True}])
async def test_null_data_anchors_match_embedded_newlines(flags):
    actual, selected = await _search(b"a\nb\0", "^a$", null_data=True, **flags)
    assert actual == "a\nb\0"
    assert selected
