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
from dataclasses import dataclass, field

from mirage.runtime.handles.chunked import ChunkedHandle
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.handles.flush import plan_flush
from mirage.runtime.handles.types import FileFetch, FlushStep


@dataclass(slots=True)
class FileHandle:
    """One open file: its stored bytes fetched as read, its writes kept.

    Nothing moves at open. A read fetches the chunk it lands in through
    ``base`` (a ``ChunkedHandle`` over the door's ranged read), and what
    the handle wrote is kept as byte ranges laid over those stored
    bytes. A close owes the mount only those ranges (``flush_plan``),
    so another writer's bytes between them survive, which a copy of the
    whole file taken at open and written back at close would undo. An
    append-mode handle writes at the end every time, wherever it read.

    Args:
        path (str): guest-absolute virtual path the handle is over.
        base (ChunkedHandle | None): the stored bytes, or None when the
            open created or emptied the file.
        writable (bool): whether writes are accepted at all; the
            dialect decides how a refusal is spelled.
        append (bool): every write lands at the end (O_APPEND).
        pos (int): the read/write position.
        base_len (int): the file's length when the handle opened it.
        runs (list[tuple[int, bytearray]]): the written ranges, sorted
            and disjoint.
        cut (int | None): the shortest length a truncate left the stored
            bytes at.
        extent (int): the length the last truncate set, the floor under
            what the stored bytes and the ranges reach.
        truncated (bool): whether a truncate ran since open.
    """

    path: str
    base: ChunkedHandle | None = None
    writable: bool = False
    append: bool = False
    pos: int = 0
    base_len: int = 0
    runs: list[tuple[int, bytearray]] = field(default_factory=list)
    cut: int | None = None
    extent: int = 0
    truncated: bool = False

    @classmethod
    def opened(
        cls,
        path: str,
        fetch: FileFetch | None,
        *,
        size: int,
        writable: bool,
        append: bool,
    ) -> "FileHandle":
        """A handle over a file, positioned by the open mode.

        A file that fits in one chunk is fetched whole on its first
        read, since whole is what the file cache keeps; a larger one a
        chunk at a time.

        Args:
            path (str): guest-absolute virtual path.
            fetch (FileFetch | None): the door's
                read of ``(offset, size)``, a None size reading to the
                end; None when the open created or emptied the file.
            size (int): the file's length as the open saw it.
            writable (bool): whether writes are accepted.
            append (bool): every write lands at the end, and the position
                starts there.
        """
        base = None
        if fetch is not None:
            door = fetch

            def ranged(offset: int, asked: int) -> bytes:
                if offset == 0 and size <= READ_CHUNK:
                    return door(0, None)
                return door(offset, asked)

            base = ChunkedHandle(path=path, size=size, fetch=ranged)
        handle = cls(
            path=path,
            base=base,
            writable=writable,
            append=append,
            base_len=0 if base is None else size,
        )
        if append:
            handle.pos = handle.size
        return handle

    @classmethod
    def of_bytes(cls, path: str, data: bytes) -> "FileHandle":
        """A read-only handle over bytes already in hand (a stdin).

        Args:
            path (str): the name the handle answers to.
            data (bytes): the whole content.
        """
        return cls.opened(
            path,
            lambda offset, size: (
                data[offset:] if size is None else data[offset : offset + size]
            ),
            size=len(data),
            writable=False,
            append=False,
        )

    @property
    def size(self) -> int:
        """The file's length as this handle holds it."""
        return max(self._stored_end(), self._runs_end(), self.extent)

    @property
    def eof(self) -> bool:
        """True when the position sits at or past the end.

        At the end the open saw, one byte is asked for: a backend that
        reports no size answers 0, and only a read finds its real end.
        """
        if self.pos < self.size:
            return False
        return not self.pread(self.pos, 1)

    @property
    def dirty(self) -> bool:
        """Whether the handle owes the mount anything at close."""
        return bool(self.runs) or self.truncated

    def _stored_end(self) -> int:
        if self.base is None:
            return 0
        end = self.base.size
        return end if self.cut is None else min(end, self.cut)

    def _runs_end(self) -> int:
        if not self.runs:
            return 0
        start, data = self.runs[-1]
        return start + len(data)

    def pread(self, offset: int, size: int) -> bytes:
        """Read at an explicit offset without moving the position.

        The stored bytes come first, as far as they reach (a truncate
        hides what lies past its cut); the handle's own ranges are laid
        over them, and a gap the handle grew the file across reads as
        zeros.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        if size <= 0:
            return b""
        out = bytearray()
        if self.base is not None and (self.cut is None or offset < self.cut):
            want = size if self.cut is None else min(size, self.cut - offset)
            out += self.base.pread(offset, want)
        reach = min(offset + size, max(self._runs_end(), self.extent))
        if offset + len(out) < reach:
            out += bytes(reach - offset - len(out))
        for start, data in self.runs:
            low = max(start, offset)
            high = min(start + len(data), offset + len(out))
            if low < high:
                out[low - offset : high - offset] = data[
                    low - start : high - start
                ]
        return bytes(out)

    def read(self, size: int | None = None) -> bytes:
        """Read from the position, advancing it by what was read.

        Args:
            size (int | None): byte budget; None or negative reads to
                the end. A position past the end reads empty and stays.
        """
        if size is not None and size >= 0:
            chunk = self.pread(self.pos, size)
            self.pos += len(chunk)
            return chunk
        out = bytearray()
        while True:
            chunk = self.pread(self.pos, READ_CHUNK)
            out += chunk
            self.pos += len(chunk)
            if len(chunk) < READ_CHUNK:
                return bytes(out)

    def pwrite(self, offset: int, data: bytes) -> None:
        """Write bytes at an offset without moving the position.

        The write joins the ranges it overlaps or touches, so a stream of
        writes stays one range and a later write wins where it overlaps.

        Args:
            offset (int): byte offset to write at.
            data (bytes): the payload.
        """
        if not data:
            return
        end = offset + len(data)
        if self.runs:
            start, last = self.runs[-1]
            if start <= offset <= start + len(last):
                last[offset - start : end - start] = data
                return
        merged_start, merged_end = offset, end
        keep: list[tuple[int, bytearray]] = []
        joined: list[tuple[int, bytearray]] = []
        for start, run in self.runs:
            if start + len(run) < offset or start > end:
                keep.append((start, run))
            else:
                joined.append((start, run))
                merged_start = min(merged_start, start)
                merged_end = max(merged_end, start + len(run))
        merged = bytearray(merged_end - merged_start)
        for start, run in joined:
            merged[start - merged_start : start - merged_start + len(run)] = (
                run
            )
        merged[offset - merged_start : end - merged_start] = data
        keep.append((merged_start, merged))
        keep.sort(key=lambda run: run[0])
        self.runs = keep

    def write(self, data: bytes) -> None:
        """Write at the position (the end, in append mode), advancing it.

        Args:
            data (bytes): the payload.
        """
        if self.append:
            self.pos = self.size
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
        base = {0: 0, 1: self.pos, 2: self.size}.get(whence)
        if base is None or base + offset < 0:
            return None
        self.pos = base + offset
        return self.pos

    def truncate(self, size: int) -> None:
        """Set the file's length: a shrink drops bytes, growth reads zeros.

        Args:
            size (int): the new length.
        """
        # ftruncate(2) sets the length outright, so a cut to the length
        # this handle holds still drops what another writer appended
        # since the open.
        if self.base is not None and size <= self.size:
            self.cut = size if self.cut is None else min(self.cut, size)
        if size < self.size:
            kept: list[tuple[int, bytearray]] = []
            for start, run in self.runs:
                if start < size:
                    kept.append((start, run[: size - start]))
            self.runs = kept
        self.extent = size
        self.truncated = True

    def settle(self, fetch: FileFetch) -> None:
        """Take what was just flushed as the stored bytes, owing nothing.

        After a flush the mount holds what the handle held, so the
        handle reads it back from there and keeps writing over it; a
        second flush then owes only what came after the first.

        Args:
            fetch (FileFetch): the door's read
                of the stored bytes, as ``opened`` takes it.
        """
        size = self.size
        self.base = ChunkedHandle(path=self.path, size=size, fetch=fetch)
        self.base_len = size
        self.runs = []
        self.cut = None
        self.extent = 0
        self.truncated = False

    def flush_plan(self) -> list[FlushStep]:
        """The ops this handle owes the mount at close."""
        if not self.dirty:
            return []
        return plan_flush(
            base_len=self.base_len,
            runs=self.runs,
            cut=self.cut,
            size=self.size,
            appending=self.append,
        )


def write_runs(
    writes: Iterable[tuple[int, bytes]],
) -> list[tuple[int, bytes]]:
    """Buffered (offset, payload) writes as the fewest pwrites that leave
    a file as the writes did, in arrival order.

    The kernel adapters buffer each write on its handle and owe the mount
    the lot at flush. A write that starts inside the last run, or right
    at its end, folds into it, so a sequential stream is one run. Any
    other starts a run of its own; the runs apply in order, so a later
    run still overwrites what it overlaps of an earlier one.

    Args:
        writes (Iterable[tuple[int, bytes]]): the buffered writes, in
            arrival order.
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
