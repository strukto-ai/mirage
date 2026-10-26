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

from collections.abc import Iterable


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
