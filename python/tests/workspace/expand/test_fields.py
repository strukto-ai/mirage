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

import asyncio

import pytest

from mirage.utils.glob_walk import mark_globs
from mirage.workspace.expand.fields import (
    chunks_text,
    ifs_joiner,
    join_chunks,
    splat_chunks,
    split_fields,
    value_piece,
)
from mirage.workspace.expand.types import FieldBreak, Piece


@pytest.mark.parametrize(
    "ifs,joiner", [(None, " "), (",", ","), (", ", ","), ("", "")]
)
def test_ifs_joiner_is_the_first_character(ifs, joiner):
    assert ifs_joiner(ifs) == joiner


@pytest.mark.parametrize(
    "text,ifs,fields",
    [
        # Unset IFS splits on blank runs and drops them at both ends.
        (" a  b\t\nc ", None, ["a", "b", "c"]),
        # A non-blank IFS character delimits exactly one field.
        ("a,,b,", ",", ["a", "", "b"]),
        (",a", ",", ["", "a"]),
        # Blanks around a non-blank separator belong to it.
        (" a , b ,,c ", ", ", ["a", "b", "", "c"]),
        # A blank not in IFS is text.
        ("a\tb c", " ", ["a\tb", "c"]),
        ("a b\nc", "\n", ["a b", "c"]),
        # An empty IFS splits nothing.
        ("a b", "", ["a b"]),
    ],
)
@pytest.mark.asyncio
async def test_split_fields_reads_ifs_as_bash_does(text, ifs, fields):
    assert await split_fields([Piece(text, True)], ifs) == fields


@pytest.mark.asyncio
async def test_split_fields_joins_literal_text_to_the_split_edges():
    chunks = [Piece("q"), Piece(" a ", True), Piece("r")]
    assert await split_fields(chunks, None) == ["q", "a", "r"]


@pytest.mark.asyncio
async def test_split_fields_never_splits_quoted_text():
    assert await split_fields([Piece("a b"), Piece(",c", True)], ",") == [
        "a b",
        "c",
    ]


@pytest.mark.asyncio
async def test_split_fields_empty_unquoted_is_no_word():
    assert await split_fields([Piece("", True)], None) == []
    assert await split_fields([Piece("  ", True)], None) == []


@pytest.mark.asyncio
async def test_split_fields_empty_quoted_is_an_empty_word():
    assert await split_fields([Piece("")], None) == [""]
    assert await split_fields([Piece(""), Piece(" a", True)], None) == [
        "",
        "a",
    ]


@pytest.mark.asyncio
async def test_split_fields_breaks_between_splat_elements():
    chunks = [
        Piece("x"),
        Piece("", True),
        FieldBreak(" "),
        Piece("", True),
        FieldBreak(" "),
        Piece("b c", True),
    ]
    assert await split_fields(chunks, "") == ["x", "b c"]


@pytest.mark.asyncio
async def test_splat_chunks_keeps_quoted_empty_elements():
    chunks = await splat_chunks(["", "*"], " ", True)
    assert await split_fields(chunks, None) == ["", mark_globs("*")]
    assert join_chunks(chunks) == " " + mark_globs("*")
    assert chunks_text(chunks) == " *"


def test_value_piece_marks_only_quoted_values():
    assert value_piece("a*", True) == Piece(mark_globs("a*"), False)
    assert value_piece("a*", False) == Piece("a*", True)


def test_join_chunks_reads_each_break_as_its_joiner():
    chunks = [Piece("a", True), FieldBreak(","), Piece("b", True)]
    assert join_chunks(chunks) == "a,b"


@pytest.mark.asyncio
async def test_split_fields_yields_across_a_long_quoted_splat():
    chunks = await splat_chunks([str(i) for i in range(200000)], " ", True)
    turns = 0

    async def tick() -> None:
        nonlocal turns
        while True:
            turns += 1
            await asyncio.sleep(0)

    ticker = asyncio.create_task(tick())
    await asyncio.sleep(0)
    before = turns
    fields = await split_fields(chunks, None)
    ticker.cancel()
    assert len(fields) == 200000
    assert turns > before
