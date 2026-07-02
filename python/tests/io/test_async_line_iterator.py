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

from mirage.io.async_line_iterator import AsyncLineIterator


async def _chunks(parts: list[bytes]):
    for p in parts:
        yield p


@pytest.mark.asyncio
async def test_clean_boundaries():
    source = _chunks([b"hello\nworld\n"])
    lines = [line async for line in AsyncLineIterator(source)]
    assert lines == [b"hello", b"world"]


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
