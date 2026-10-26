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

from mirage.io.async_line_iterator import (
    AsyncLineIterator,
    SharedInput,
    char_width,
    line_buffer,
    share,
)
from mirage.io.cooperative import chunks
from mirage.io.types import DeviceInput, materialize


async def _chunks(parts: list[bytes]):
    for p in parts:
        yield p


@pytest.mark.asyncio
async def test_clean_boundaries():
    source = _chunks([b"hello\nworld\n"])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"hello", b"world"]


@pytest.mark.asyncio
async def test_read1_answers_one_pull_up_to_its_size_and_keeps_the_rest():
    pulled = []

    async def source():
        pulled.append(1)
        yield b"abcdef"
        pulled.append(2)
        yield b"gh"

    reader = AsyncLineIterator(source())
    assert await reader.read1(4) == b"abcd"
    assert await reader.read1(4) == b"ef"
    assert pulled == [1]
    assert await reader.read1(4) == b"gh"
    assert await reader.read1(0) == b""
    assert await reader.read1(4) == b""


@pytest.mark.asyncio
async def test_split_across_chunks():
    source = _chunks([b"hel", b"lo\nwor", b"ld\n"])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"hello", b"world"]


@pytest.mark.asyncio
async def test_no_trailing_newline():
    source = _chunks([b"hello\nworld"])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"hello", b"world"]


@pytest.mark.asyncio
async def test_empty_input():
    source = _chunks([])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == []


@pytest.mark.asyncio
async def test_empty_chunk():
    source = _chunks([b"", b"hello\n", b""])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"hello"]


@pytest.mark.asyncio
async def test_single_large_line():
    big = b"x" * 100000 + b"\n"
    source = _chunks([big[:8192], big[8192:]])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"x" * 100000]


@pytest.mark.asyncio
async def test_many_lines_one_chunk():
    source = _chunks([b"a\nb\nc\nd\n"])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"a", b"b", b"c", b"d"]


@pytest.mark.asyncio
async def test_early_termination():
    pull_count = 0

    async def _counting_chunks():
        nonlocal pull_count
        for i in range(1000):
            pull_count += 1
            yield f"line{i}\n".encode()

    lines = []
    async for line in AsyncLineIterator(_counting_chunks()):
        lines.append(line)
        if len(lines) >= 3:
            break
    assert len(lines) == 3
    assert pull_count < 10


def test_char_width_steps_one_utf8_character_at_a_time():
    assert char_width(b"a") == 1
    assert char_width("é".encode()) == 2
    assert char_width("€".encode()) == 3
    assert char_width("😀".encode()) == 4
    # Bytes that decode to one replacement character each: a stray
    # continuation byte, a lead the encoding never uses, and a sequence
    # cut short by a byte that cannot continue it.
    assert char_width(b"\x80") == 1
    assert char_width(b"\xff") == 1
    assert char_width(b"\xe0A") == 1
    assert char_width(b"\xe0\xa0A") == 2
    # Never past the end of what is there.
    assert char_width("é".encode()[:1]) == 1


@pytest.mark.asyncio
async def test_read_chars_counts_characters_not_bytes():
    """`read -n 1` on `éx` takes `é` and leaves `x`, as bash does in a
    UTF-8 locale; counting bytes would split the character and leave
    the other half to corrupt the next read."""
    it = AsyncLineIterator(_chunks(["éx".encode()]))
    first, complete = await it.read_chars(1, b"\n")
    assert (first.decode(), complete) == ("é", True)
    second, complete = await it.read_chars(1, b"\n")
    assert (second.decode(), complete) == ("x", True)


@pytest.mark.asyncio
async def test_read_chars_spanning_a_chunk_boundary():
    it = AsyncLineIterator(_chunks([b"\xc3", b"\xa9x"]))
    data, complete = await it.read_chars(2, None)
    assert (data.decode(), complete) == ("éx", True)


@pytest.mark.asyncio
async def test_read_chars_stops_at_the_delimiter():
    it = AsyncLineIterator(_chunks([b"ab:cd"]))
    data, complete = await it.read_chars(4, b":")
    assert (data, complete) == (b"ab", True)


@pytest.mark.asyncio
async def test_read_chars_reports_a_short_read_at_eof():
    it = AsyncLineIterator(_chunks([b"ab"]))
    data, complete = await it.read_chars(5, None)
    assert (data, complete) == (b"ab", False)


@pytest.mark.asyncio
async def test_skip_only_buffered_empty_lines_with_limit():
    reader = AsyncLineIterator(_chunks([b"\n\n\nx\n\n", b"\nend"]))
    assert reader.skip_empty_lines() == 0
    assert await reader.readline() == b""
    assert reader.skip_empty_lines(0) == 0
    assert reader.skip_empty_lines(1) == 1
    assert reader.skip_empty_lines() == 1
    assert await reader.readline() == b"x"
    assert reader.skip_empty_lines() == 1
    assert reader.skip_empty_lines() == 0
    assert await reader.readline() == b""
    assert await reader.readline() == b"end"
    assert reader.skip_empty_lines() == 0
    assert await reader.readline() is None


@pytest.mark.asyncio
async def test_skip_nonmatching_lines_retains_candidates_across_chunks():
    chunks = [b"first\nskip\nskip\nneedle\nskip\nnee", b"dle\ntail"]

    async def source():
        for chunk in chunks:
            yield chunk

    lines = AsyncLineIterator(source())
    assert lines.skip_nonmatching_lines((b"needle",)) == (0, 0)
    assert await lines.readline() == b"first"
    assert lines.skip_nonmatching_lines((b"needle",)) == (2, 10)
    assert lines.skip_nonmatching_lines((b"needle",)) == (0, 0)
    assert await lines.readline() == b"needle"
    assert lines.skip_nonmatching_lines((b"needle",)) == (1, 5)
    assert await lines.readline() == b"needle"
    assert lines.skip_nonmatching_lines((b"needle",)) == (0, 0)
    assert await lines.readline() == b"tail"
    assert await lines.readline() is None


@pytest.mark.asyncio
async def test_skip_nonmatching_lines_interleaves_needles_under_folding():
    lines = AsyncLineIterator(_chunks([b"x\nA1\nx\nx\nb2\nx\na3\nx\nB4\nx"]))
    assert await lines.readline() == b"x"
    seen = []
    while True:
        skipped = lines.skip_nonmatching_lines((b"a", b"b"), True)
        line = await lines.readline()
        if line is None:
            break
        seen.append((skipped, line))
    assert seen == [
        ((0, 0), b"A1"),
        ((2, 4), b"b2"),
        ((1, 2), b"a3"),
        ((1, 2), b"B4"),
        ((0, 0), b"x"),
    ]


@pytest.mark.asyncio
async def test_skip_nonmatching_lines_by_another_delimiter():
    lines = AsyncLineIterator(_chunks([b"a\nb\0needle\nc\0d\0nee", b"dle\0"]))
    assert await lines.read_until(b"\0") == (b"a\nb", True)
    assert lines.skip_nonmatching_lines((b"needle",), False, b"\0") == (0, 0)
    assert await lines.read_until(b"\0") == (b"needle\nc", True)
    assert lines.skip_nonmatching_lines((b"needle",), False, b"\0") == (1, 2)
    assert await lines.read_until(b"\0") == (b"needle", True)
    assert lines.skip_nonmatching_lines((b"needle",), False, b"\0") == (0, 0)
    assert await lines.read_until(b"\0") == (b"", False)


@pytest.mark.asyncio
async def test_shared_input_hands_over_what_a_line_read_left():
    shared = SharedInput(_chunks([b"a\nb\n", b"c\n"]))
    assert await shared.lines.readline() == b"a"
    assert await materialize(shared) == b"b\nc\n"
    assert await shared.lines.readline() is None


@pytest.mark.asyncio
async def test_shared_input_reads_bytes():
    shared = SharedInput(b"a\nb\n")
    assert await shared.lines.readline() == b"a"
    assert await materialize(shared) == b"b\n"


@pytest.mark.asyncio
async def test_a_dup_is_another_descriptor_on_the_same_offset():
    shared = SharedInput(b"a\nb\nc\n")
    copy = shared.dup()
    assert copy is not shared
    assert await shared.lines.readline() == b"a"
    assert await copy.lines.readline() == b"b"
    assert await materialize(shared) == b"c\n"


@pytest.mark.asyncio
async def test_load_rest_ends_the_source_and_reads_on_from_memory():
    ended = []

    async def source():
        try:
            yield b"a\nb"
            yield b"\nc\n"
        finally:
            ended.append(True)

    lines = AsyncLineIterator(source())
    assert await lines.readline() == b"a"
    await lines.load_rest()
    assert ended == [True]
    assert [line async for line in lines] == [b"b", b"c"]


@pytest.mark.asyncio
async def test_a_reader_that_stops_early_leaves_the_rest():
    shared = SharedInput(_chunks([b"a\n", b"b\n"]))
    reader = chunks(shared)
    assert await reader.__anext__() == b"a\n"
    await reader.aclose()
    assert await shared.lines.readline() == b"b"


def test_share_wraps_once_and_leaves_dev_null_as_it_is():
    shared = share(b"x")
    assert isinstance(shared, SharedInput)
    assert share(shared) is shared
    device = DeviceInput()
    assert share(device) is device
    assert share(None) is None


@pytest.mark.asyncio
async def test_line_buffer_reads_a_shared_input_in_place():
    shared = SharedInput(b"a\nb\n")
    assert line_buffer(shared) is shared.lines
    assert await line_buffer(b"a\nb\n").readline() == b"a"
