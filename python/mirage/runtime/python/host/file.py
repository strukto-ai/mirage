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
import functools
import io
from collections.abc import Callable
from typing import IO, TYPE_CHECKING, Any, cast

from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.types import FsCondition
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import FileHandle
from mirage.runtime.handles.mode import OpenMode, parse_mode
from mirage.runtime.open import apply_open
from mirage.runtime.python.host.syscall import host_files, syscall
from mirage.workspace.files import Files

if TYPE_CHECKING:
    from _typeshed import ReadableBuffer, WriteableBuffer
# `io.open`'s own sentinel for "whatever the platform default is". It is
# not a codec name, and pathlib passes it for every `read_text()` on an
# interpreter that is not in UTF-8 mode (which is any interpreter whose
# LC_CTYPE is already a UTF-8 locale, so: the normal case), so looking
# the caller's word up as a codec raised LookupError on the ordinary
# path the moment `io.open` was patched.
LOCALE_ENCODING = "locale"


def read_range(
    adapter: RuntimeFiles,
    path: str,
    raw: bool,
    offset: int,
    size: int | None,
) -> bytes:
    """Read a range of a mounted file for a handle.

    A handle that writes reads the stored bytes, since its writes land on
    them; a read-only one sees the rendering.

    Args:
        adapter (RuntimeFiles): the file adapter.
        path (str): the mounted path.
        raw (bool): read the stored bytes rather than the rendering.
        offset (int): where the range starts.
        size (int | None): how many bytes; None reads to the end.
    """
    return syscall(adapter.read)(path, offset=offset, size=size, raw=raw)


def raw_mode(facts: OpenMode) -> str:
    """The mode ``io.FileIO`` reports for these facts.

    Args:
        facts (OpenMode): what the open's mode string said.
    """
    plus = "+" if facts.readable and facts.writable else ""
    if facts.exclusive:
        return "xb" + plus
    if facts.append:
        return "ab" + plus
    if facts.readable:
        return "rb" + plus
    return "wb"


class HandleRaw(io.RawIOBase):
    """A raw stream over a file handle, for CPython's buffered layers.

    The same layering CPython puts over a real file: a buffered stream
    over this raw one, and a text stream over that for a text mode. Its
    ``flush`` lands the handle's writes on the mount, which a close, and
    a flush through the layers above, comes down to.

    Args:
        adapter (RuntimeFiles): the file adapter writes land through.
        handle (FileHandle): the handle it reads and writes through.
        readable (bool): whether the mode reads.
        mode (str): the mode ``io.FileIO`` would report.
        release (Callable[[], None] | None): what a close gives back
            once its writes landed, the descriptor a stream over one
            owns; None for a plain open.
    """

    def __init__(
        self,
        adapter: RuntimeFiles,
        handle: FileHandle,
        readable: bool,
        mode: str,
        release: Callable[[], None] | None = None,
    ) -> None:
        super().__init__()
        self._adapter = adapter
        self._handle = handle
        self._readable = readable
        self._release = release
        self.name = handle.path
        self.mode = mode

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

    def flush(self) -> None:
        super().flush()
        steps = self._handle.flush_plan()
        if not steps:
            return
        syscall(self._adapter.flush)(self.name, steps)
        self._handle.settle(
            functools.partial(read_range, self._adapter, self.name, True)
        )

    def close(self) -> None:
        if self.closed:
            return
        try:
            super().close()
        finally:
            if self._release is not None:
                self._release()


class _LandingWriter(io.BufferedWriter):
    """A buffered writer whose flush reaches the mount, as a flush of a
    real file reaches the kernel; CPython's never calls ``raw.flush``."""

    def flush(self) -> None:
        super().flush()
        self.raw.flush()


class _LandingRandom(io.BufferedRandom):
    """``_LandingWriter`` for a mode that reads and writes."""

    def flush(self) -> None:
        super().flush()
        self.raw.flush()


def text_encoding(
    facts: OpenMode,
    encoding: str | None,
    errors: str | None,
    newline: str | None,
) -> str:
    """Check a mode's text arguments as ``io.open`` does, and the
    encoding a text stream uses.

    Args:
        facts (OpenMode): what the mode string said.
        encoding (str | None): the encoding asked for.
        errors (str | None): the error policy asked for.
        newline (str | None): the newline translation asked for.
    """
    if facts.binary:
        if encoding is not None:
            raise ValueError("binary mode doesn't take an encoding argument")
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
    return encoding


def layered(
    raw: HandleRaw,
    facts: OpenMode,
    mode: str,
    encoding: str | None = None,
    errors: str | None = None,
    newline: str | None = None,
) -> IO[bytes] | IO[str]:
    """The buffered stream CPython picks for the mode over ``raw``, and a
    text stream over it for a text mode, as ``io.open`` builds them.

    Args:
        raw (HandleRaw): the raw stream.
        facts (OpenMode): what the mode string said.
        mode (str): the mode string, which a text stream reports.
        encoding (str | None): the text encoding.
        errors (str | None): the text error policy.
        newline (str | None): the newline translation.
    """
    buffered: io.BufferedIOBase
    if facts.readable and facts.writable:
        buffered = _LandingRandom(raw)
    elif facts.writable:
        buffered = _LandingWriter(raw)
    else:
        buffered = io.BufferedReader(raw)
    if facts.binary:
        return buffered
    text = io.TextIOWrapper(
        buffered,
        encoding=encoding,
        errors=errors if errors is not None else "strict",
        newline=newline,
    )
    cast(Any, text).mode = mode
    return text


def open_file(
    files: Files,
    path: str,
    mode: str = "r",
    loop: asyncio.AbstractEventLoop | None = None,
    encoding: str | None = None,
    errors: str | None = None,
    newline: str | None = None,
) -> IO[bytes] | IO[str]:
    """Open a mounted file as ``open`` does a real one.

    The result is CPython's own buffered or text stream over a raw one
    on the mount, so everything a file object offers (``seekable``,
    ``readline(size)``, ``readinto``, zipfile, a ``TextIOWrapper`` over a
    binary open) behaves as on disk. Writes land on a flush or a close.

    Args:
        files (Files): the workspace's ``ws.vfs``.
        path (str): the mounted path.
        mode (str): the open mode.
        loop (asyncio.AbstractEventLoop | None): the block's loop.
        encoding (str | None): the text encoding; the ``locale``
            sentinel and None take utf-8.
        errors (str | None): the text error policy.
        newline (str | None): the newline translation.
    """
    adapter = host_files(files, loop)
    facts = parse_mode(mode)
    encoding = text_encoding(facts, encoding, errors, newline)
    # The open's effect lands now, by the rule every entry point shares; a
    # refusal leaves nothing open, so nothing flushes behind it.
    row = apply_open(adapter, path, facts)
    # Nothing is read at open: the handle fetches what a read lands
    # in, and keeps what was written until a flush.
    handle = FileHandle.opened(
        path,
        None
        if row is None
        else functools.partial(read_range, adapter, path, facts.writable),
        size=0 if row is None else row.size,
        writable=facts.writable,
        append=facts.append,
    )
    raw = HandleRaw(adapter, handle, facts.readable, raw_mode(facts))
    if facts.binary:
        return layered(raw, facts, mode)
    return layered(raw, facts, mode, encoding, errors, newline)
