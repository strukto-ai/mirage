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

from collections.abc import Callable
from dataclasses import dataclass

from mirage.runtime.handles.constants import READ_CHUNK


@dataclass(slots=True)
class ChunkedHandle:
    """A read-only handle that fetches its file a chunk at a time.

    The read-side twin of ``FileHandle``, for a read-only open of a file
    larger than one chunk; a smaller file is read whole, since whole is
    what the file cache keeps. Nothing moves at open: a read fetches the
    chunk it lands in through the file adapter's ranged read, and that chunk is
    kept so a sequential read of small pieces costs one request per
    chunk. The file ends where a fetch comes back short, not at the size
    the open saw: a rendering need not be as long as the stored bytes a
    stat measured, so that size answers only until the end has been seen.

    Args:
        path (str): guest-absolute virtual path the handle is over.
        size (int): the file's length as the open saw it.
        fetch (Callable[[int, int], bytes] | None): the file adapter's
            ranged read, ``(offset, size)`` to the bytes there. None for an
            async owner (the mount core), which asks ``missing``, fetches
            itself and hands the bytes to ``keep``.
        pos (int): the read position.
        generation (int): bumped by ``drop``, so an async owner can tell
            the file changed while its fetch was out.
    """

    path: str
    size: int
    fetch: Callable[[int, int], bytes] | None = None
    pos: int = 0
    generation: int = 0
    _start: int = 0
    _kept: bytes = b""
    _end: int | None = None

    def pread(self, offset: int, size: int) -> bytes:
        """Read at an explicit offset without moving the position.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        asked = self.missing(offset, size)
        if asked is not None:
            if self.fetch is None:
                raise RuntimeError(
                    f"{self.path}: no ranged read to fetch with"
                )
            self.keep(offset, self.fetch(offset, asked), asked)
        return self.peek(offset, size)

    def missing(self, offset: int, size: int) -> int | None:
        """How many bytes a read at ``offset`` must fetch from there.

        Args:
            offset (int): byte offset the read starts at.
            size (int): byte budget.

        Returns:
            int | None: the fetch size, or None when the kept chunk (or
            the end of the file) already answers the read.
        """
        if size <= 0 or (self._end is not None and offset >= self._end):
            return None
        kept_end = self._start + len(self._kept)
        inside = self._start <= offset < kept_end and (
            offset + size <= kept_end or kept_end == self._end
        )
        return None if inside else max(size, READ_CHUNK)

    def keep(self, offset: int, data: bytes, asked: int) -> None:
        """Keep a fetched chunk; a short one marks the end of the file.

        Args:
            offset (int): where the chunk starts.
            data (bytes): the fetched bytes.
            asked (int): how many were asked for.
        """
        self._start = offset
        self._kept = data
        if len(data) < asked:
            self._end = offset + len(data)
            self.size = self._end

    def peek(self, offset: int, size: int) -> bytes:
        """The kept bytes at ``offset``, without fetching.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        low = offset - self._start
        if size <= 0 or low < 0:
            return b""
        return self._kept[low : low + size]

    def read(self, size: int) -> bytes:
        """Read from the position, advancing it by what was read.

        Args:
            size (int): byte budget.
        """
        chunk = self.pread(self.pos, size)
        self.pos += len(chunk)
        return chunk

    def seek(self, offset: int, whence: int) -> int | None:
        """Move the position, POSIX whence numbering.

        Args:
            offset (int): displacement from the whence base.
            whence (int): 0 from the start, 1 from the position, 2
                from the end.

        Returns:
            int | None: the new position, or None when the whence is
            unknown or the target would be negative.
        """
        base = {0: 0, 1: self.pos, 2: self.size}.get(whence)
        if base is None or base + offset < 0:
            return None
        self.pos = base + offset
        return self.pos

    def drop(self) -> None:
        """Forget the kept chunk: the next read fetches the file anew."""
        self.generation += 1
        self._kept, self._end = b"", None
