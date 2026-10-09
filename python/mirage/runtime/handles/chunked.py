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
    chunk it lands in through the entry point's ranged read, and that chunk is
    kept so a sequential read of small pieces costs one request per
    chunk. The file ends where a fetch comes back short, not at the size
    the open saw: a rendering need not be as long as the stored bytes a
    stat measured, so that size answers only until the end has been seen.

    Args:
        path (str): guest-absolute virtual path the handle is over.
        size (int): the file's length as the open saw it.
        fetch (Callable[[int, int], bytes]): the entry point's ranged read,
            ``(offset, size)`` to the bytes there.
        pos (int): the read position.
    """

    path: str
    size: int
    fetch: Callable[[int, int], bytes]
    pos: int = 0
    _start: int = 0
    _kept: bytes = b""
    _end: int | None = None

    def pread(self, offset: int, size: int) -> bytes:
        """Read at an explicit offset without moving the position.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        if size <= 0 or (self._end is not None and offset >= self._end):
            return b""
        kept_end = self._start + len(self._kept)
        inside = self._start <= offset < kept_end and (
            offset + size <= kept_end or kept_end == self._end
        )
        if not inside:
            asked = max(size, READ_CHUNK)
            self._start = offset
            self._kept = self.fetch(offset, asked)
            if len(self._kept) < asked:
                self._end = offset + len(self._kept)
                self.size = self._end
        low = offset - self._start
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
        self._kept, self._end = b"", None
