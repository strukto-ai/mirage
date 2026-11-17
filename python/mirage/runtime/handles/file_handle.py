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

from collections.abc import AsyncIterator, Iterable, Iterator
from itertools import groupby
from typing import TypeVar

from mirage.io.spool import MEMORY_LIMIT, ByteSlice

_Chunk = TypeVar("_Chunk", bound=bytes | bytearray | ByteSlice)


def write_end(
    writes: Iterable[tuple[int, bytes | bytearray | ByteSlice]], stored: int
) -> int:
    """Where the file ends after the buffered writes.

    Args:
        writes (Iterable): offsets and their in-memory or spooled payloads.
        stored (int): the end before the writes.
    """
    end = stored
    for offset, chunk in writes:
        end = max(end, offset + len(chunk))
    return end


def write_runs(
    writes: Iterable[tuple[int, bytes | bytearray]],
) -> list[tuple[int, bytes]]:
    """Merge each run into one pwrite payload for flush. Apply edits in
    arrival order so the latest write wins wherever two overlap.

    Args:
        writes (Iterable[tuple[int, bytes | bytearray]]): the buffered
            writes, in arrival order.
    """
    runs: list[tuple[int, bytes]] = []
    for start, group in _grouped(writes):
        buf = bytearray()
        for offset, chunk in group:
            at = offset - start
            buf[at : at + len(chunk)] = chunk
        runs.append((start, bytes(buf)))
    return runs


def overlaid(
    stored: bytes,
    offset: int,
    size: int,
    writes: Iterable[tuple[int, bytes | bytearray]],
) -> bytes:
    """A read window with a handle's buffered writes laid over it.

    The kernel adapters keep a handle's writes until flush; a read
    through that handle sees them, as a read after write(2) does. They
    apply in arrival order, so a later write wins where it overlaps, and
    a gap a write grew the file across reads as zeros.

    Args:
        stored (bytes): the stored bytes from ``offset``, short where the
            stored file ends.
        offset (int): where the window starts.
        size (int): the window's length.
        writes (Iterable[tuple[int, bytes | bytearray]]): the buffered
            writes, in arrival order.
    """
    runs = list(writes)
    end = min(offset + size, write_end(runs, offset + len(stored)))
    if end <= offset:
        return b""
    out = bytearray(stored[: end - offset])
    out.extend(bytes(end - offset - len(out)))
    for start, data in runs:
        low, high = max(start, offset), min(start + len(data), end)
        if low < high:
            out[low - offset : high - offset] = data[
                low - start : high - start
            ]
    return bytes(out)


def _grouped(
    writes: Iterable[tuple[int, _Chunk]],
) -> Iterator[tuple[int, Iterator[tuple[int, _Chunk]]]]:
    """Group writes by the start of the current run. A write inside the
    run or at its end joins it. A gap or a write before its start opens
    another run.

    Args:
        writes (Iterable): offsets and their in-memory or spooled payloads.
    """
    start = end = 0

    def run_start(write: tuple[int, _Chunk]) -> int:
        nonlocal start, end
        offset, chunk = write
        if not start <= offset <= end:
            start = end = offset
        end = max(end, offset + len(chunk))
        return start

    return groupby(writes, run_start)


def run_groups(
    writes: Iterable[tuple[int, _Chunk]],
) -> list[list[tuple[int, _Chunk]]]:
    """Keep each run's original writes for a streamed flush or a retry.

    Args:
        writes (Iterable): offsets and their in-memory or spooled payloads.
    """
    return [list(group) for _, group in _grouped(writes)]


async def window_writes(
    writes: Iterable[tuple[int, bytes | bytearray | ByteSlice]],
    offset: int,
    size: int,
) -> list[tuple[int, bytes | bytearray]]:
    """Buffered writes as ``overlaid`` lays them over a read window: a
    write waiting in a spool is read for the part of the window it
    covers, and past that keeps only where it ends, so the read still
    reaches as far as the file does. Each spool stays open until the
    window is read, so a handle that lands and goes meanwhile still
    shows what it held to a read that took its writes.

    Args:
        writes (Iterable[tuple[int, bytes | bytearray | ByteSlice]]): the
            buffered writes, in arrival order.
        offset (int): where the window starts.
        size (int): the window's length.
    """
    writes = list(writes)
    spools = {run.source for _, run in writes if isinstance(run, ByteSlice)}
    for spool in spools:
        spool.hold()
    try:
        out: list[tuple[int, bytes | bytearray]] = []
        for at, run in writes:
            if not isinstance(run, ByteSlice):
                out.append((at, run))
                continue
            low, high = max(at, offset), min(at + len(run), offset + size)
            if low < high:
                out.append(
                    (
                        low,
                        await run.source.read(
                            run.offset + low - at, high - low
                        ),
                    )
                )
            out.append((at + len(run), b""))
        return out
    finally:
        for spool in spools:
            await spool.unhold()


async def run_stream(
    group: list[tuple[int, bytearray | ByteSlice]],
) -> AsyncIterator[bytes]:
    """The bytes one group of buffered writes leaves, from where it
    starts to where it reaches, a window at a time. Each window lays
    only the writes that reach it, so a flush costs the writes plus the
    windows, however many small edits a large file has.

    Args:
        group (list[tuple[int, bytearray | ByteSlice]]): one of
            ``run_groups``.
    """
    start = group[0][0]
    end = write_end(group, start)
    windows: list[list[tuple[int, bytearray | ByteSlice]]] = [
        [] for _ in range(-(-(end - start) // MEMORY_LIMIT))
    ]
    for at, run in group:
        first = (at - start) // MEMORY_LIMIT
        last = (at + len(run) - 1 - start) // MEMORY_LIMIT
        for index in range(first, last + 1):
            windows[index].append((at, run))
    for index, writes in enumerate(windows):
        offset = start + index * MEMORY_LIMIT
        size = min(MEMORY_LIMIT, end - offset)
        yield overlaid(
            b"", offset, size, await window_writes(writes, offset, size)
        )
