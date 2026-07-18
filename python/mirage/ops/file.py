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
from collections.abc import Awaitable, Iterable, Iterator
from types import TracebackType
from typing import Self, TypeVar

from mirage.bridge.sync import run_async_from_sync
from mirage.ops import Ops

T = TypeVar("T")
logger = logging.getLogger(__name__)


def _parse_mode(mode: str) -> tuple[str, bool, bool, bool]:
    valid = set("rwaxbt+")
    if (not mode or any(char not in valid for char in mode)
            or sum(mode.count(char) for char in "rwax") != 1
            or mode.count("+") > 1 or mode.count("b") > 1
            or mode.count("t") > 1 or ("b" in mode and "t" in mode)):
        raise ValueError(f"invalid mode: {mode!r}")
    base = next(char for char in "rwax" if char in mode)
    readable = base == "r" or "+" in mode
    writable = base != "r" or "+" in mode
    return base, "b" in mode, readable, writable


class MirageFile:

    def __init__(
        self,
        ops: Ops,
        path: str,
        mode: str = "r",
        loop: asyncio.AbstractEventLoop | None = None,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> None:
        self._closed = True
        self._ops = ops
        self._path = path
        self._mode = mode
        self._loop = loop
        self._base_mode, self._binary, self._readable, self._writable = \
            _parse_mode(mode)
        if self._binary:
            if encoding is not None:
                raise ValueError(
                    "binary mode doesn't take an encoding argument")
            if errors is not None:
                raise ValueError("binary mode doesn't take an errors argument")
            if newline is not None:
                raise ValueError("binary mode doesn't take a newline argument")
        elif newline not in (None, "", "\n", "\r", "\r\n"):
            raise ValueError(f"illegal newline value: {newline!r}")
        self._encoding = encoding if encoding is not None else "utf-8"
        self._errors = errors if errors is not None else "strict"
        self._newline = newline
        codecs.lookup(self._encoding)
        self._closed = False
        self._dirty = False
        self._buf: io.BytesIO | io.StringIO | None = None
        if self._base_mode == "w":
            self._run(self._ops.create(self._path))
        elif self._base_mode == "x":
            try:
                self._run(self._ops.stat(self._path))
            except FileNotFoundError:
                self._run(self._ops.create(self._path))
            else:
                raise FileExistsError(self._path)
        elif self._base_mode == "a":
            try:
                self._run(self._ops.stat(self._path))
            except FileNotFoundError:
                self._run(self._ops.create(self._path))

    def _run(self, coro: Awaitable[T]) -> T:
        return run_async_from_sync(coro, self._loop)

    def _load(self) -> io.BytesIO | io.StringIO:
        if self._buf is not None:
            return self._buf
        if self._base_mode in ("w", "x"):
            if self._binary:
                self._buf = io.BytesIO()
            else:
                self._buf = io.StringIO(newline=self._newline)
            return self._buf
        if self._base_mode == "a":
            data = self._run(self._ops.read(self._path))
            if self._binary:
                self._buf = io.BytesIO(data)
            else:
                self._buf = io.StringIO(data.decode(self._encoding,
                                                    self._errors),
                                        newline=self._newline)
            self._buf.seek(0, 2)
            return self._buf
        data = self._run(self._ops.read(self._path))
        if self._binary:
            self._buf = io.BytesIO(data)
        else:
            self._buf = io.StringIO(data.decode(self._encoding, self._errors),
                                    newline=self._newline)
        return self._buf

    def _check_closed(self) -> None:
        if self._closed:
            raise ValueError("I/O operation on closed file")

    def _read_buffer(self) -> io.BytesIO | io.StringIO:
        self._check_closed()
        if not self.readable():
            raise io.UnsupportedOperation("not readable")
        return self._load()

    def _write_buffer(self) -> io.BytesIO | io.StringIO:
        self._check_closed()
        if not self.writable():
            raise io.UnsupportedOperation("not writable")
        return self._load()

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
        if isinstance(buffer, io.BytesIO):
            if not isinstance(data, bytes):
                raise TypeError("a bytes-like object is required")
            written = buffer.write(data)
            self._dirty = True
            return written
        if not isinstance(data, str):
            raise TypeError("string argument expected")
        written = buffer.write(data)
        self._dirty = True
        return written

    def writelines(self, lines: Iterable[bytes] | Iterable[str]) -> None:
        for line in lines:
            self.write(line)

    def seek(self, offset: int, whence: int = 0) -> int:
        self._check_closed()
        return self._load().seek(offset, whence)

    def tell(self) -> int:
        self._check_closed()
        return self._load().tell()

    def flush(self) -> None:
        self._check_closed()
        if not self._dirty or self._buf is None:
            return
        val = self._buf.getvalue()
        if isinstance(val, str):
            val = val.encode(self._encoding, self._errors)
        self._run(self._ops.write(self._path, val))
        self._dirty = False

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.flush()
        finally:
            self._closed = True
            if self._buf is not None:
                self._buf.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            logger.debug("failed to close mounted file %s",
                         self._path,
                         exc_info=True)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: type[BaseException] | None,
                 exc_value: BaseException | None,
                 traceback: TracebackType | None) -> None:
        self.close()

    def __iter__(self) -> Iterator[bytes] | Iterator[str]:
        buffer = self._read_buffer()
        if isinstance(buffer, io.BytesIO):
            return iter(buffer)
        return iter(buffer)

    def __next__(self) -> bytes | str:
        buffer = self._read_buffer()
        if isinstance(buffer, io.BytesIO):
            return next(buffer)
        return next(buffer)
