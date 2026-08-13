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
from io import SEEK_CUR, SEEK_END, SEEK_SET

from mirage.bridge.sync import run_async_from_sync
from mirage.commands.cli.builtin.git.io import read_range
from mirage.runtime.types import DispatchFn

# Measured on a 19-pack, 400 MB repository reading one commit: 64 KiB
# costs 3.4 MB over 63 requests, 256 KiB costs 7.6 MB over 37, and 1 MiB
# costs 11.2 MB over 23. Smaller blocks buy bandwidth and spend
# round trips, which is the wrong way round on an object store where a
# GET is tens of milliseconds. 256 KiB is the middle. Note that 19 of
# those fetches only want a 12-byte pack header, so any block size
# over-fetches them.
BLOCK = 1 << 18


class LazyFile:
    """A read-only seekable file over a mount path, fetched in blocks.

    dulwich reaches a packfile through nothing but ``seek`` and ``read``,
    so a packfile living in a mount never has to be pulled whole: reads
    are served from a block cache and only the blocks a read lands in are
    fetched. Pulling one commit out of a 400 MB pack costs a block or
    two, which is the same trick git plays with mmap windows, minus the
    kernel doing it for us.

    Blocking by design. The dulwich object store is synchronous, so the
    caller runs it on a worker thread and each fetch is marshalled back
    onto the workspace's event loop.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path of the file.
        size (int): the file's byte length.
        loop (asyncio.AbstractEventLoop): the loop serving the mount.
    """

    def __init__(self, dispatch: DispatchFn, path: str, size: int,
                 loop: asyncio.AbstractEventLoop) -> None:
        self._dispatch = dispatch
        self._path = path
        self._size = size
        self._loop = loop
        self._blocks: dict[int, bytes] = {}
        self._position = 0

    def _block(self, index: int) -> bytes:
        """Fetch one block, or serve it from the cache.

        Args:
            index (int): block number, counted in BLOCK-sized units.
        """
        cached = self._blocks.get(index)
        if cached is not None:
            return cached
        start = index * BLOCK
        length = min(BLOCK, self._size - start)
        data = run_async_from_sync(
            read_range(self._dispatch, self._path, start, length), self._loop)
        self._blocks[index] = data
        return data

    def read(self, size: int = -1) -> bytes:
        """Read from the current position, advancing it.

        Args:
            size (int): how many bytes, or -1 for the rest of the file.
        """
        if size < 0:
            size = self._size - self._position
        size = max(0, min(size, self._size - self._position))
        if size == 0:
            return b""
        chunks = []
        remaining = size
        while remaining > 0:
            index, inside = divmod(self._position, BLOCK)
            piece = self._block(index)[inside:inside + remaining]
            if not piece:
                break
            chunks.append(piece)
            self._position += len(piece)
            remaining -= len(piece)
        return b"".join(chunks)

    def seek(self, offset: int, whence: int = SEEK_SET) -> int:
        """Move the read position.

        Args:
            offset (int): byte offset, relative to whence.
            whence (int): SEEK_SET, SEEK_CUR or SEEK_END.
        """
        if whence == SEEK_SET:
            self._position = offset
        elif whence == SEEK_CUR:
            self._position += offset
        elif whence == SEEK_END:
            self._position = self._size + offset
        else:
            raise ValueError(f"invalid whence: {whence}")
        self._position = max(0, self._position)
        return self._position

    def tell(self) -> int:
        return self._position

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return True

    def close(self) -> None:
        self._blocks.clear()
