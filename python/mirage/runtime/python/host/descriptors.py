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

import errno
import functools
import os
from dataclasses import dataclass
from typing import IO, Any, cast

from mirage.errors.fs import fs_error
from mirage.errors.types import FsCondition
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import FileHandle
from mirage.runtime.handles.mode import OpenMode, parse_mode
from mirage.runtime.open import apply_open
from mirage.runtime.python.host.file import (
    HandleRaw,
    layered,
    raw_mode,
    read_range,
    text_encoding,
)
from mirage.runtime.python.host.syscall import syscall


def open_mode(flags: int) -> OpenMode:
    """What open(2) flags say about a handle, in the mode vocabulary.

    Args:
        flags (int): the ``os.O_*`` flags.
    """
    access = flags & os.O_ACCMODE
    writable = access in (os.O_WRONLY, os.O_RDWR)
    create = bool(flags & os.O_CREAT)
    return OpenMode(
        readable=access in (os.O_RDONLY, os.O_RDWR),
        writable=writable,
        truncate=writable and bool(flags & os.O_TRUNC),
        append=bool(flags & os.O_APPEND),
        create=create,
        exclusive=create and bool(flags & os.O_EXCL),
        binary=True,
    )


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


@dataclass
class Descriptor:
    """One descriptor ``os.open`` handed out for a mounted path.

    Args:
        path (str): the mounted path it names now; a rename through the
            same entry point moves it.
        facts (OpenMode): what its flags asked for.
        handle (FileHandle | None): the file it reads and writes; None
            for a directory, which a descriptor may name but not read.
        kept (bytes | None): the bytes its file had when its name was
            removed or replaced, which it reads from then on and never
            lands on; None while it has a name.
    """

    path: str
    facts: OpenMode
    handle: FileHandle | None = None
    kept: bytes | None = None


class Descriptors:
    """The descriptors ``os.open`` hands out for mounted paths, by number.

    Each number is a real host descriptor, the read end of a pipe whose
    write end is closed, held open as long as the mounted one is: it
    never collides with a file the host opens meanwhile, and a call that
    still reaches the host with it (a C extension) meets an empty stream,
    never another file or a shared device. Writes stay in the handle
    until a ``close`` or an ``fsync``. A descriptor follows its file
    through a rename made through this entry point, and keeps the bytes
    it had once one removes or replaces its name, as POSIX keeps an open
    descriptor on its inode.

    Args:
        adapter (RuntimeFiles): the file adapter files land through.
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

    def _fetch(
        self, desc: Descriptor, raw: bool, offset: int, size: int | None
    ) -> bytes:
        """A range of a descriptor's file: what it kept once its name went,
        else what is at its path now.

        Args:
            desc (Descriptor): the descriptor.
            raw (bool): read the stored bytes rather than the rendering.
            offset (int): where the range starts.
            size (int | None): how many bytes; None reads to the end.
        """
        if desc.kept is not None:
            end = None if size is None else offset + size
            return desc.kept[offset:end]
        return read_range(self._adapter, desc.path, raw, offset, size)

    def open(self, path: str, flags: int) -> int:
        """Open a mounted path by open(2) flags and number the result.

        Args:
            path (str): the mounted path.
            flags (int): the ``os.O_*`` flags.
        """
        facts = open_mode(flags)
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
        desc = Descriptor(path, facts)
        if not (
            row is not None
            and row.is_dir
            and not (facts.writable or facts.create)
        ):
            opened = apply_open(self._adapter, path, facts)
            desc.handle = FileHandle.opened(
                path,
                None
                if opened is None
                else functools.partial(self._fetch, desc, facts.writable),
                size=0 if opened is None else opened.size,
                writable=facts.writable,
                append=facts.append,
            )
        fd, write_end = cast(tuple[int, int], self._host.pipe())
        self._host.close(write_end)
        self._open[fd] = desc
        return fd

    def land(self, desc: Descriptor) -> None:
        """Land a descriptor's writes on the mount; one whose name went
        keeps them, as writes to an unlinked file stay with it.

        Args:
            desc (Descriptor): the descriptor.
        """
        handle = desc.handle
        if handle is None or desc.kept is not None:
            return
        steps = handle.flush_plan()
        if not steps:
            return
        syscall(self._adapter.flush)(desc.path, steps)
        handle.settle(functools.partial(self._fetch, desc, True))

    def land_path(self, path: str) -> None:
        """Land the writes of every descriptor open on ``path``, which a
        change of its times must come after.

        Args:
            path (str): the mounted path.
        """
        for desc in list(self._open.values()):
            if desc.path == path:
                self.land(desc)

    def moved(self, old: str, new: str) -> None:
        """Follow a rename: a descriptor on ``old`` or under it names the
        same file at ``new`` now.

        Args:
            old (str): the path the rename took.
            new (str): the path it gave.
        """
        under = old.rstrip("/") + "/"
        for desc in self._open.values():
            if desc.kept is None and (
                desc.path == old or desc.path.startswith(under)
            ):
                desc.path = new + desc.path[len(old) :]

    def hold(self, path: str) -> list[tuple[Descriptor, bytes]]:
        """Read what the descriptors open on ``path`` need before its name
        is removed or replaced; ``keep`` them once it has gone.

        Args:
            path (str): the path about to go.
        """
        held: list[tuple[Descriptor, bytes]] = []
        views: dict[bool, bytes] = {}
        for desc in self._open.values():
            if desc.path != path or desc.kept is not None:
                continue
            if desc.handle is None:
                continue
            raw = desc.facts.writable
            if raw not in views:
                views[raw] = read_range(self._adapter, path, raw, 0, None)
            held.append((desc, views[raw]))
        return held

    @staticmethod
    def keep(held: list[tuple[Descriptor, bytes]]) -> None:
        """Detach the descriptors ``hold`` read for, now their name went.

        Args:
            held (list[tuple[Descriptor, bytes]]): what ``hold`` returned.
        """
        for desc, data in held:
            desc.kept = data

    def close(self, fd: int) -> None:
        """Land a descriptor's writes and give its number back.

        Args:
            fd (int): a mounted descriptor.
        """
        desc = self._open.pop(fd, None)
        if desc is None:
            raise OSError(errno.EBADF, os.strerror(errno.EBADF))
        try:
            self.land(desc)
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
        desc = self._open[fd]
        if desc.handle is None:
            raise fs_error(desc.path, FsCondition.EISDIR)
        facts = parse_mode(mode)
        encoding = text_encoding(facts, encoding, errors, newline, buffering)
        raw = HandleRaw(
            self._adapter,
            desc.handle,
            facts.readable and desc.facts.readable,
            raw_mode(facts),
            functools.partial(self.close, fd) if closefd else None,
            fd,
        )
        if facts.binary:
            return layered(raw, facts, mode, buffering=buffering)
        return layered(raw, facts, mode, encoding, errors, newline, buffering)

    def file(self, fd: int, want_read: bool, want_write: bool) -> FileHandle:
        """The handle a read or a write through ``fd`` uses.

        Args:
            fd (int): a mounted descriptor.
            want_read (bool): the call reads.
            want_write (bool): the call writes.
        """
        desc = self._open[fd]
        if desc.handle is None:
            raise fs_error(desc.path, FsCondition.EISDIR)
        if (want_read and not desc.facts.readable) or (
            want_write and not desc.facts.writable
        ):
            raise fs_error(desc.path, FsCondition.EBADF)
        return desc.handle
