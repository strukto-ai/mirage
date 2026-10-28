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

from mirage.io.spool import MEMORY_LIMIT, ByteSlice, ByteSpool
from mirage.io.types import materialize
from mirage.runtime.handles import file_handle
from mirage.runtime.handles.file_handle import (
    overlaid,
    run_groups,
    run_stream,
    window_writes,
    write_runs,
)


def test_write_runs_fold_a_sequential_stream_into_one():
    assert write_runs([(0, b"ab"), (2, b"cd"), (4, b"e")]) == [(0, b"abcde")]
    assert write_runs([(0, b"new"), (1, b"O")]) == [(0, b"nOw")]
    assert write_runs([]) == []


def test_write_runs_keep_scattered_writes_apart_and_in_order():
    assert write_runs([(0, b"a"), (10, b"b")]) == [(0, b"a"), (10, b"b")]
    assert write_runs([(4, b"xy"), (0, b"abcdef")]) == [
        (4, b"xy"),
        (0, b"abcdef"),
    ]


def test_overlaid_lays_writes_over_the_stored_window_in_arrival_order():
    writes = [(1, b"XY"), (2, b"Z")]
    assert overlaid(b"abcd", 0, 4, writes) == b"aXZd"
    assert overlaid(b"cd", 2, 2, writes) == b"Zd"


def test_overlaid_grows_the_file_and_reads_a_gap_as_zeros():
    assert overlaid(b"ab", 0, 10, [(4, b"Q")]) == b"ab\x00\x00Q"
    assert overlaid(b"", 8, 4, [(4, b"Q")]) == b""


def test_run_groups_hold_the_writes_each_run_folds():
    writes = [(0, b"ab"), (1, b"X"), (2, b"cd"), (10, b"q"), (0, b"z")]
    groups = run_groups(writes)
    assert groups == [
        [(0, b"ab"), (1, b"X"), (2, b"cd")],
        [(10, b"q")],
        [(0, b"z")],
    ]
    assert [write_runs(group)[0] for group in groups] == write_runs(writes)


@pytest.mark.asyncio
async def test_window_writes_read_a_spooled_write_for_the_window_alone():
    async with ByteSpool() as spool:
        await spool.append(b"0123456789")
        writes = [(100, ByteSlice(spool, 0, 10)), (104, b"XY")]
        assert await window_writes(writes, 102, 4) == [
            (102, b"2345"),
            (110, b""),
            (104, b"XY"),
        ]
        laid = await window_writes(writes, 96, 2)
        assert laid == [(110, b""), (104, b"XY")]
        assert overlaid(b"", 96, 2, laid) == bytes(2)


@pytest.mark.asyncio
async def test_window_writes_keep_a_spool_open_until_the_window_is_read():
    spool = ByteSpool()
    await spool.append(b"abcdef")
    reading, go = asyncio.Event(), asyncio.Event()
    read = spool.read

    async def held_up(offset: int, size: int) -> bytes:
        reading.set()
        await go.wait()
        return await read(offset, size)

    spool.read = held_up  # type: ignore[method-assign]
    window = asyncio.create_task(
        window_writes([(0, ByteSlice(spool, 0, 6))], 0, 6)
    )
    await reading.wait()
    await spool.close()
    assert not spool.closed
    go.set()
    assert await window == [(0, b"abcdef"), (6, b"")]
    assert spool.closed


@pytest.mark.asyncio
async def test_run_stream_leaves_what_the_folded_run_holds():
    data = bytes(range(256)) * 10240
    async with ByteSpool() as spool:
        await spool.append(data)
        group = [
            (0, ByteSlice(spool, 0, len(data))),
            (2, bytearray(b"XY")),
            (len(data), bytearray(b"tail")),
        ]
        folded = write_runs([(0, data), (2, b"XY"), (len(data), b"tail")])
        assert await materialize(run_stream(group)) == folded[0][1]


@pytest.mark.asyncio
async def test_run_stream_lays_each_window_with_the_writes_that_reach_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = bytes(range(256)) * (3 * MEMORY_LIMIT // 256)
    seen: list[int] = []

    async def counted(
        writes: list[tuple[int, bytearray | ByteSlice]], offset: int, size: int
    ) -> list[tuple[int, bytes | bytearray]]:
        seen.append(len(writes))
        return await window_writes(writes, offset, size)

    monkeypatch.setattr(file_handle, "window_writes", counted)
    async with ByteSpool() as spool:
        await spool.append(data)
        edits = [(10, b"a"), (2 * MEMORY_LIMIT + 5, b"b")]
        group = [
            (0, ByteSlice(spool, 0, len(data))),
            *((at, bytearray(edit)) for at, edit in edits),
        ]
        folded = write_runs([(0, data), *edits])
        assert await materialize(run_stream(group)) == folded[0][1]
    assert seen == [2, 1, 2]
