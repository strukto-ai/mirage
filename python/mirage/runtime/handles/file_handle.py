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
from dataclasses import dataclass

from mirage.runtime.handles.flush import NO_WRITE, FlushKind, plan_flush


@dataclass(slots=True)
class FileHandle:
    """One buffered whole-file handle.

    The shape every encoder used to hand-roll: open snapshots the file
    into a growable buffer, byte-level calls touch only that buffer,
    and close asks ``flush_plan`` whether the mount is owed a tail or
    the whole file. ``low_write`` and ``dirty`` exist purely to answer
    that closing question.

    Args:
        path (str): guest-absolute virtual path the handle is over.
        buf (bytearray): the whole file, mutated in place.
        pos (int): the read/write position.
        writable (bool): whether writes are accepted at all; the
            dialect decides how a refusal is spelled.
        base_len (int): length the file had when the handle opened.
        low_write (int): lowest offset written at, NO_WRITE until then.
        dirty (bool): whether anything was written since open.
    """

    path: str
    buf: bytearray
    pos: int = 0
    writable: bool = False
    base_len: int = 0
    low_write: int = NO_WRITE
    dirty: bool = False

    @classmethod
    def opened(cls, path: str, data: bytes, *, writable: bool,
               append: bool) -> "FileHandle":
        """A handle over `data`, positioned by the open mode.

        Args:
            path (str): guest-absolute virtual path.
            data (bytes): the file's content at open (empty when the
                open created or truncated it).
            writable (bool): whether writes are accepted.
            append (bool): start positioned at the end.
        """
        buf = bytearray(data)
        return cls(path=path,
                   buf=buf,
                   pos=len(buf) if append else 0,
                   writable=writable,
                   base_len=len(buf))

    def read(self, size: int | None = None) -> bytes:
        """Read from the position, advancing it by what was read.

        Args:
            size (int | None): byte budget; None or negative reads to
                the end. A position past the end reads empty and stays.
        """
        if size is None or size < 0:
            end = len(self.buf)
        else:
            end = min(len(self.buf), self.pos + size)
        chunk = bytes(self.buf[self.pos:end])
        self.pos += len(chunk)
        return chunk

    def pread(self, offset: int, size: int) -> bytes:
        """Read at an explicit offset without moving the position.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        return bytes(self.buf[offset:offset + size])

    def pwrite(self, offset: int, data: bytes) -> None:
        """Splice bytes in at an offset without moving the position.

        Grows the buffer through a zero fill when the offset lies past
        the end, and keeps the two facts the closing flush plan reads:
        the lowest offset written and that anything was written at all.

        Args:
            offset (int): byte offset to write at.
            data (bytes): the payload.
        """
        if offset > len(self.buf):
            self.buf += b"\0" * (offset - len(self.buf))
        self.low_write = min(self.low_write, offset)
        self.buf[offset:offset + len(data)] = data
        self.dirty = True

    def write(self, data: bytes) -> None:
        """Write at the position, advancing it past the payload.

        Args:
            data (bytes): the payload.
        """
        self.pwrite(self.pos, data)
        self.pos += len(data)

    def seek(self, offset: int, whence: int) -> int | None:
        """Move the position, POSIX whence numbering.

        Args:
            offset (int): displacement from the whence base.
            whence (int): 0 from the start, 1 from the position, 2
                from the end.

        Returns:
            int | None: the new position, or None when the whence is
            unknown or the target would be negative (the position is
            then untouched).
        """
        base = {0: 0, 1: self.pos, 2: len(self.buf)}.get(whence)
        if base is None or base + offset < 0:
            return None
        self.pos = base + offset
        return self.pos

    def truncate(self, size: int) -> None:
        """Resize the buffer, zero-filling growth.

        Either direction rewrites what the file already held (a shrink
        drops bytes, a zero-fill fabricates them), which no tail can
        express, so the close ships the whole buffer.

        Args:
            size (int): the new length.
        """
        if size < len(self.buf):
            del self.buf[size:]
        else:
            self.buf += b"\0" * (size - len(self.buf))
        self.dirty = True
        self.low_write = 0

    @property
    def eof(self) -> bool:
        """True when the position sits at or past the end."""
        return self.pos >= len(self.buf)

    def flush_plan(self) -> tuple[FlushKind, bytes]:
        """What this handle owes the mount at close."""
        return plan_flush(self.base_len, self.low_write, self.buf)


def merge_writes(base: bytes, writes: Iterable[tuple[int, bytes]]) -> bytes:
    """Apply buffered (offset, payload) writes over a base file.

    The batch form of the pwrite splice, for the kernel adapters: FUSE
    buffers each write as an (offset, payload) pair on its handle and
    owes the mount one merged body at flush, which is exactly a
    sequence of pwrites over what the file held.

    Args:
        base (bytes): the file's content before this handle's writes.
        writes (Iterable[tuple[int, bytes]]): the buffered writes, in
            arrival order.
    """
    handle = FileHandle(path="", buf=bytearray(base), writable=True)
    for offset, chunk in writes:
        handle.pwrite(offset, chunk)
    return bytes(handle.buf)
