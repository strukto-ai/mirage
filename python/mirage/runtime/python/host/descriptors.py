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

import dataclasses
import errno
import os
from typing import IO, Any, cast

from mirage.errors.fs import fs_error
from mirage.errors.types import FsCondition
from mirage.runtime.files import Descriptor, RuntimeFiles
from mirage.runtime.handles.mode import OpenMode, open_mode, parse_mode
from mirage.runtime.python.host.file import (
    HandleRaw,
    layered,
    raw_mode,
    text_encoding,
)
from mirage.runtime.python.host.syscall import syscall


def open_flags(facts: OpenMode) -> int:
    """The open(2) flags ``io.open`` passes an opener for these facts.

    Args:
        facts (OpenMode): what the mode string said.
    """
    if facts.readable and facts.writable:
        flags = os.O_RDWR
    elif facts.writable:
        flags = os.O_WRONLY
    else:
        flags = os.O_RDONLY
    if facts.create:
        flags |= os.O_CREAT
    if facts.exclusive:
        flags |= os.O_EXCL
    if facts.truncate:
        flags |= os.O_TRUNC
    if facts.append:
        flags |= os.O_APPEND
    return flags | getattr(os, "O_CLOEXEC", 0)


class Descriptors:
    """The mounted files open through this entry point, by number for
    ``os.open``; ``open`` hands out a stream over one with no number.

    Each number is a real host descriptor, the read end of a pipe whose
    write end is closed, held open as long as the mounted one is: it
    never collides with a file the host opens meanwhile, and a call that
    still reaches the host with it (a C extension) meets an empty stream,
    never another file or a shared device. What a file holds and what a
    descriptor wrote are the core's (``RuntimeFiles.open``), which lands
    the writes at a close, a flush or an ``fsync``, follows a rename and
    keeps the file a removal or a replacement took the name of, as POSIX
    keeps an open file on its inode.

    Args:
        adapter (RuntimeFiles): the file adapter files open through.
        host (Any): the host ``os`` functions the router snapshotted.
    """

    def __init__(self, adapter: RuntimeFiles, host: Any) -> None:
        self._adapter = adapter
        self._host = host
        self._open: dict[int, Descriptor] = {}

    def get(self, fd: Any) -> Descriptor | None:
        """The mounted descriptor ``fd`` is, else None.

        Args:
            fd (Any): what the caller passed as a descriptor.
        """
        if not isinstance(fd, int) or isinstance(fd, bool):
            return None
        return self._open.get(fd)

    def __getitem__(self, fd: int) -> Descriptor:
        """The mounted descriptor ``fd`` is; EBADF for any other number.

        Args:
            fd (int): a descriptor.
        """
        desc = self._open.get(fd)
        if desc is None:
            raise OSError(errno.EBADF, os.strerror(errno.EBADF))
        return desc

    def _opened(
        self, path: str, facts: OpenMode, directory: bool = False
    ) -> Descriptor:
        """A descriptor on ``path`` once the open's effect landed. Nothing
        is read at open: the core fetches what a read lands in.

        Args:
            path (str): the mounted path.
            facts (OpenMode): what the open asked for.
            directory (bool): the path is a directory the open may name.
        """
        fh = syscall(self._adapter.open)(path, facts)
        desc = Descriptor(
            self._adapter,
            fh,
            facts,
            path,
            directory,
            inode=self._adapter.walked(path),
        )
        if facts.append:
            desc.seek(0, 2)
        return desc

    def open(self, path: str, flags: int) -> int:
        """Open a mounted path by open(2) flags and number the result.

        Args:
            path (str): the mounted path.
            flags (int): the ``os.O_*`` flags.
        """
        facts = dataclasses.replace(open_mode(flags), directory=True)
        nofollow = bool(flags & getattr(os, "O_NOFOLLOW", 0))
        row = syscall(self._adapter.stat_or_none)(path, nofollow=nofollow)
        if row is not None and row.is_link:
            raise fs_error(path, FsCondition.ELOOP)
        if flags & getattr(os, "O_DIRECTORY", 0) and (
            row is None or not row.is_dir
        ):
            raise fs_error(
                path,
                FsCondition.ENOENT if row is None else FsCondition.ENOTDIR,
            )
        desc = self._opened(path, facts, row is not None and row.is_dir)
        fd, write_end = cast(tuple[int, int], self._host.pipe())
        self._host.close(write_end)
        self._open[fd] = desc
        return fd

    def open_file(
        self,
        path: str,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> IO[bytes] | IO[str]:
        """``open`` on a mounted path: CPython's own buffered and text
        streams over a descriptor with no number, so everything a file
        object offers behaves as on disk, but ``fileno``, which has
        nothing to answer. The arguments are checked before the open
        lands.

        Args:
            path (str): the mounted path.
            mode (str): the open mode.
            buffering (int): ``io.open``'s buffering; 0 is unbuffered.
            encoding (str | None): the text encoding; the ``locale``
                sentinel and None take utf-8.
            errors (str | None): the text error policy.
            newline (str | None): the newline translation.
        """
        facts = parse_mode(mode)
        encoding = text_encoding(facts, encoding, errors, newline, buffering)
        desc = self._opened(path, facts)
        raw = HandleRaw(
            desc,
            facts.readable,
            facts.writable,
            raw_mode(facts),
            release=desc.close,
        )
        return layered(raw, facts, mode, encoding, errors, newline, buffering)

    def close(self, fd: int) -> None:
        """Land a descriptor's writes and give its number back.

        Args:
            fd (int): a mounted descriptor.
        """
        desc = self._open.pop(fd, None)
        if desc is None:
            raise OSError(errno.EBADF, os.strerror(errno.EBADF))
        try:
            desc.close()
        finally:
            self._host.close(fd)

    def stream(
        self,
        fd: int,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
        closefd: bool = True,
    ) -> IO[bytes] | IO[str]:
        """A file object over a descriptor, as ``os.fdopen`` makes one: no
        open effect lands again, ``fileno`` answers the descriptor, and its
        close closes the descriptor unless ``closefd`` says otherwise.

        Args:
            fd (int): a mounted descriptor.
            mode (str): the file object's mode.
            buffering (int): ``io.open``'s buffering; 0 is unbuffered.
            encoding (str | None): the text encoding.
            errors (str | None): the text error policy.
            newline (str | None): the newline translation.
            closefd (bool): close the descriptor with the file object.
        """
        desc = self[fd]
        if desc.directory:
            raise fs_error(desc.path, FsCondition.EISDIR)
        facts = parse_mode(mode)
        encoding = text_encoding(facts, encoding, errors, newline, buffering)
        if facts.append:
            desc.seek(0, 2)
        raw = HandleRaw(
            desc,
            facts.readable and desc.mode.readable,
            facts.writable and desc.mode.writable,
            raw_mode(facts),
            lambda: self._open.get(fd) is desc,
            (lambda: self.close(fd)) if closefd else None,
            fd,
        )
        return layered(raw, facts, mode, encoding, errors, newline, buffering)

    def file(self, fd: int, want_read: bool, want_write: bool) -> Descriptor:
        """The descriptor a read or a write through ``fd`` uses.

        Args:
            fd (int): a mounted descriptor.
            want_read (bool): the call reads.
            want_write (bool): the call writes.
        """
        desc = self[fd]
        if desc.directory:
            raise fs_error(desc.path, FsCondition.EISDIR)
        if (want_read and not desc.mode.readable) or (
            want_write and not desc.mode.writable
        ):
            raise fs_error(desc.path, FsCondition.EBADF)
        return desc
