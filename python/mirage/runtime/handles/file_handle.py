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

import logging
from collections.abc import AsyncIterator, Iterable

from mirage.io.spool import MEMORY_LIMIT, ByteSlice

logger = logging.getLogger(__name__)


def write_runs(
    writes: Iterable[tuple[int, bytes | bytearray]],
) -> list[tuple[int, bytes]]:
    """Buffered (offset, payload) writes as the fewest pwrites that leave
    a file as the writes did, in arrival order.

    The kernel adapters buffer each write on its handle and owe the mount
    the lot at flush. A write that starts inside the last run, or right
    at its end, folds into it, so a sequential stream is one run. Any
    other starts a run of its own; the runs apply in order, so a later
    run still overwrites what it overlaps of an earlier one.

    Args:
        writes (Iterable[tuple[int, bytes | bytearray]]): the buffered
            writes, in arrival order.
    """
    runs: list[tuple[int, bytearray]] = []
    for offset, chunk in writes:
        if runs:
            start, buf = runs[-1]
            if start <= offset <= start + len(buf):
                buf[offset - start : offset - start + len(chunk)] = chunk
                continue
        runs.append((offset, bytearray(chunk)))
    return [(start, bytes(buf)) for start, buf in runs]


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
    reach = max([offset + len(stored)] + [o + len(d) for o, d in runs])
    end = min(offset + size, reach)
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


def run_groups(
    writes: Iterable[tuple[int, bytearray | ByteSlice]],
) -> list[list[tuple[int, bytearray | ByteSlice]]]:
    """Buffered writes in the groups ``write_runs`` folds into one run
    each, unfolded, for a buffer some of whose writes wait in a spool.

    Args:
        writes (Iterable[tuple[int, bytearray | ByteSlice]]): the buffered
            writes, in arrival order.
    """
    groups: list[list[tuple[int, bytearray | ByteSlice]]] = []
    end = 0
    for offset, chunk in writes:
        if groups and groups[-1][0][0] <= offset <= end:
            groups[-1].append((offset, chunk))
            end = max(end, offset + len(chunk))
            continue
        groups.append([(offset, chunk)])
        end = offset + len(chunk)
    return groups


async def window_writes(
    writes: Iterable[tuple[int, bytes | bytearray | ByteSlice]],
    offset: int,
    size: int,
) -> list[tuple[int, bytes | bytearray]]:
    """Buffered writes as ``overlaid`` lays them over a read window: a
    write waiting in a spool is read for the part of the window it
    covers, and past that keeps only where it ends, so the read still
    reaches as far as the file does. A spool closed meanwhile was a
    handle's that has gone and landed what it held, so its writes are
    left out, as a buffer that landed under a read is.

    Args:
        writes (Iterable[tuple[int, bytes | bytearray | ByteSlice]]): the
            buffered writes, in arrival order.
        offset (int): where the window starts.
        size (int): the window's length.
    """
    out: list[tuple[int, bytes | bytearray]] = []
    for at, run in writes:
        if not isinstance(run, ByteSlice):
            out.append((at, run))
            continue
        low, high = max(at, offset), min(at + len(run), offset + size)
        if low < high:
            try:
                data = await run.source.read(run.offset + low - at, high - low)
            except ValueError:
                if not run.source.closed:
                    raise
                logger.debug("a spooled write at %d landed under a read", at)
                continue
            out.append((low, data))
        out.append((at + len(run), b""))
    return out


async def run_stream(
    group: list[tuple[int, bytearray | ByteSlice]],
) -> AsyncIterator[bytes]:
    """The bytes one group of buffered writes leaves, from where it
    starts to where it reaches, a window at a time.

    Args:
        group (list[tuple[int, bytearray | ByteSlice]]): one of
            ``run_groups``.
    """
    start = group[0][0]
    end = max(at + len(run) for at, run in group)
    for offset in range(start, end, MEMORY_LIMIT):
        size = min(MEMORY_LIMIT, end - offset)
        yield overlaid(
            b"", offset, size, await window_writes(group, offset, size)
        )
