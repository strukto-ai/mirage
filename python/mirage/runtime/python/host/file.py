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
import codecs
import io
import logging
from collections.abc import Iterable, Iterator
from types import TracebackType
from typing import TYPE_CHECKING, Self

from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.types import FsCondition
from mirage.runtime.handles import FileHandle
from mirage.runtime.handles.mode import parse_mode
from mirage.runtime.open import apply_open
from mirage.runtime.python.host.fs import door_files, syscall
from mirage.workspace.files import Files

if TYPE_CHECKING:
    from _typeshed import ReadableBuffer, WriteableBuffer

logger = logging.getLogger(__name__)
# `io.open`'s own sentinel for "whatever the platform default is". It is
# not a codec name, and pathlib passes it for every `read_text()` on an
# interpreter that is not in UTF-8 mode (which is any interpreter whose
# LC_CTYPE is already a UTF-8 locale, so: the normal case), so looking
# the caller's word up as a codec raised LookupError on the ordinary
# path the moment `io.open` was patched.
LOCALE_ENCODING = "locale"


class _HandleRaw(io.RawIOBase):
    """A raw stream over a file handle, for CPython's buffered layers.

    The same layering CPython puts over a real file: a buffered stream
    over this raw one, and a text stream over that for a text mode.

    Args:
        handle (FileHandle): the handle it reads and writes through.
        readable (bool): whether the mode reads.
    """

    def __init__(self, handle: FileHandle, readable: bool) -> None:
        super().__init__()
        self._handle = handle
        self._readable = readable

    def readable(self) -> bool:
        return self._readable

    def writable(self) -> bool:
        return self._handle.writable

    def seekable(self) -> bool:
        return True

    def readinto(self, buffer: "WriteableBuffer") -> int:
        chunk = self._handle.read(len(memoryview(buffer)))
        memoryview(buffer).cast("B")[: len(chunk)] = chunk
        return len(chunk)

    def write(self, data: "ReadableBuffer") -> int:
        payload = bytes(data)
        self._handle.write(payload)
        return len(payload)

    def seek(self, offset: int, whence: int = 0) -> int:
        pos = self._handle.seek(offset, whence)
        if pos is None:
            raise OSError(
                posix_errno(FsCondition.EINVAL),
                posix_phrase(FsCondition.EINVAL),
            )
        return pos

    def tell(self) -> int:
        return self._handle.pos

    def truncate(self, size: int | None = None) -> int:
        size = self._handle.pos if size is None else size
        self._handle.truncate(size)
        return size


class MirageFile:
    def __init__(
        self,
        files: Files,
        path: str,
        mode: str = "r",
        loop: asyncio.AbstractEventLoop | None = None,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> None:
        self._closed = True
        self._door = door_files(files, loop)
        self._path = path
        self._mode = mode
        self._facts = parse_mode(mode)
        self._binary = self._facts.binary
        self._readable = self._facts.readable
        self._writable = self._facts.writable
        if self._binary:
            if encoding is not None:
                raise ValueError(
                    "binary mode doesn't take an encoding argument"
                )
            if errors is not None:
                raise ValueError("binary mode doesn't take an errors argument")
            if newline is not None:
                raise ValueError("binary mode doesn't take a newline argument")
        elif newline not in (None, "", "\n", "\r", "\r\n"):
            raise ValueError(f"illegal newline value: {newline!r}")
        # The sentinel resolves to mirage's own default rather than to
        # `locale.getencoding()`, so `open(p).read()` and
        # `Path(p).read_text()` agree about one file's bytes; a mount
        # stores utf-8 whatever the host's locale happens to be.
        if encoding is None or encoding == LOCALE_ENCODING:
            encoding = "utf-8"
        codecs.lookup(encoding)
        # The open's effect lands now, by the rule every door shares; a
        # refusal leaves the file closed, so nothing flushes behind it.
        row = apply_open(self._door, path, self._facts)
        # Nothing is read at open: the handle fetches what a read lands
        # in, and keeps what was written until a flush.
        self._handle = FileHandle.opened(
            path,
            None if row is None else self._read_range,
            size=0 if row is None else row.size,
            writable=self._writable,
            append=self._facts.append,
        )
        # The buffered class CPython picks for the mode: a reader, a
        # writer, or both for a `+` mode.
        raw = _HandleRaw(self._handle, self._readable)
        buffered: io.BufferedIOBase
        if self._readable and self._writable:
            buffered = io.BufferedRandom(raw)
        elif self._writable:
            buffered = io.BufferedWriter(raw)
        else:
            buffered = io.BufferedReader(raw)
        self._buf: io.BufferedIOBase | io.TextIOWrapper = (
            buffered
            if self._binary
            else io.TextIOWrapper(
                buffered,
                encoding=encoding,
                errors=errors if errors is not None else "strict",
                newline=newline,
            )
        )
        self._closed = False

    def _read_range(self, offset: int, size: int | None) -> bytes:
        # A handle that writes reads the stored bytes, since its writes
        # land on them; a read-only one sees the rendering.
        return syscall(self._door.read)(
            self._path, offset=offset, size=size, raw=self._writable
        )

    def _check_closed(self) -> None:
        if self._closed:
            raise ValueError("I/O operation on closed file")

    def _read_buffer(self) -> io.BufferedIOBase | io.TextIOWrapper:
        self._check_closed()
        if not self.readable():
            raise io.UnsupportedOperation("not readable")
        return self._buf

    def _write_buffer(self) -> io.BufferedIOBase | io.TextIOWrapper:
        self._check_closed()
        if not self.writable():
            raise io.UnsupportedOperation("not writable")
        return self._buf

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def name(self) -> str:
        return self._path

    @property
    def mode(self) -> str:
        return self._mode

    def readable(self) -> bool:
        return self._readable

    def writable(self) -> bool:
        return self._writable

    def read(self, size: int = -1) -> bytes | str:
        return self._read_buffer().read(size)

    def readline(self) -> bytes | str:
        return self._read_buffer().readline()

    def readlines(self) -> list[bytes] | list[str]:
        return self._read_buffer().readlines()

    def write(self, data: bytes | str) -> int:
        buffer = self._write_buffer()
        if isinstance(buffer, io.TextIOWrapper):
            if not isinstance(data, str):
                raise TypeError(
                    f"write() argument must be str, not {type(data).__name__}"
                )
            return buffer.write(data)
        if isinstance(data, str):
            raise TypeError("a bytes-like object is required, not 'str'")
        return buffer.write(data)

    def writelines(self, lines: Iterable[bytes] | Iterable[str]) -> None:
        for line in lines:
            self.write(line)

    def seek(self, offset: int, whence: int = 0) -> int:
        self._check_closed()
        return self._buf.seek(offset, whence)

    def truncate(self, size: int | None = None) -> int:
        return self._write_buffer().truncate(size)

    def fileno(self) -> int:
        # No descriptor backs a mounted file, so this answers as an
        # in-memory stream does.
        raise io.UnsupportedOperation("fileno")

    def tell(self) -> int:
        self._check_closed()
        return self._buf.tell()

    def flush(self) -> None:
        self._check_closed()
        self._buf.flush()
        steps = self._handle.flush_plan()
        if not steps:
            return
        syscall(self._door.flush)(self._path, steps)
        self._handle.settle(self._read_range)

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.flush()
        finally:
            self._closed = True
            self._buf.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            logger.debug(
                "failed to close mounted file %s", self._path, exc_info=True
            )

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def __iter__(self) -> Iterator[bytes] | Iterator[str]:
        buffer = self._read_buffer()
        if isinstance(buffer, io.TextIOWrapper):
            return iter(buffer)
        return iter(buffer)

    def __next__(self) -> bytes | str:
        buffer = self._read_buffer()
        if isinstance(buffer, io.TextIOWrapper):
            return next(buffer)
        return next(buffer)
