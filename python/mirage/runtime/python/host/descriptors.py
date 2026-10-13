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
import logging
import os
from dataclasses import dataclass
from typing import IO, Any, cast

from mirage.commands.builtin.utils.paths import walk_spelling
from mirage.errors.fs import fs_error
from mirage.errors.types import FsCondition
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import FileHandle, Kept, apply_flush
from mirage.runtime.handles.mode import OpenMode, parse_mode
from mirage.runtime.open import apply_open
from mirage.runtime.python.host.file import (
    HandleRaw,
    layered,
    raw_mode,
    text_encoding,
)
from mirage.runtime.python.host.syscall import syscall
from mirage.types import PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.view.types import NamespaceLinks

logger = logging.getLogger(__name__)


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
    """One mounted file ``os.open`` or ``open`` has open.

    Args:
        path (str): the mounted path it names now, as the open's walk
            reached it (``Descriptors.walked``); a rename through the
            same entry point moves it.
        facts (OpenMode): what its flags or mode asked for.
        handle (FileHandle | None): the file it reads and writes; None
            for a directory, which a descriptor may name but not read.
        kept (Kept | None): its file once the name was removed or
            replaced, which it reads and lands on from then on; None
            while it has a name.
        opened (str): the path it was opened at, which its inode number
            comes from however the file is renamed since.
    """

    path: str
    facts: OpenMode
    handle: FileHandle | None = None
    kept: Kept | None = None
    opened: str = ""

    def __post_init__(self) -> None:
        if not self.opened:
            self.opened = self.path


class Descriptors:
    """The mounted files open through this entry point: by number for
    ``os.open``, unnumbered for ``open``.

    Each number is a real host descriptor, the read end of a pipe whose
    write end is closed, held open as long as the mounted one is: it
    never collides with a file the host opens meanwhile, and a call that
    still reaches the host with it (a C extension) meets an empty stream,
    never another file or a shared device. Writes stay in the handle
    until a ``close``, a flush or an ``fsync``. Every open file follows
    its file through a rename made through this entry point, and keeps
    the bytes it had once one removes or replaces its name, as POSIX
    keeps an open file on its inode.

    Args:
        adapter (RuntimeFiles): the file adapter files land through.
        host (Any): the host ``os`` functions the router snapshotted.
        links (NamespaceLinks | None): the namespace's links, which a
            walk follows; None while the workspace keeps none.
    """

    def __init__(
        self, adapter: RuntimeFiles, host: Any, links: NamespaceLinks | None
    ) -> None:
        self._adapter = adapter
        self._host = host
        self._links = links
        self._open: dict[int, Descriptor] = {}
        self._unnumbered: dict[int, Descriptor] = {}

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

    def walked(self, path: str, follow: bool = True) -> str:
        """The path an op on ``path`` lands on, as the dispatcher walks
        it: a link in front of a dot followed before the climb, the dots
        resolved, and the final link followed too when ``follow``. One
        file reads as one path whichever spelling reached it, which is
        how a rename or an unlink finds the files open on it.

        Args:
            path (str): the mounted path as the caller spelled it.
            follow (bool): follow the final name too; a rename or a
                removal acts on the name itself.
        """
        spec = PathSpec.from_str_path(path, cwd="/")
        if self._links is None:
            return spec.virtual
        try:
            spelled = walk_spelling(spec, self._links.follow)
            head, _, name = spelled.rpartition("/")
            if follow or name in ("", ".", ".."):
                return resolve_path(self._links.follow(spelled), "/")
            above = resolve_path(self._links.follow(head or "/"), "/")
        except CycleError:
            raise fs_error(path, FsCondition.ELOOP) from None
        return above.rstrip("/") + "/" + name

    def _every(self) -> list[Descriptor]:
        """Every open file, numbered or not."""
        return [*self._open.values(), *self._unnumbered.values()]

    def _fetch(
        self, desc: Descriptor, raw: bool, offset: int, size: int | None
    ) -> bytes:
        """A range of a descriptor's file: what it kept once its name went,
        else what is at its path now. A handle that writes reads the
        stored bytes, since its writes land on them; a read-only one sees
        the rendering.

        Args:
            desc (Descriptor): the descriptor.
            raw (bool): read the stored bytes rather than the rendering.
            offset (int): where the range starts.
            size (int | None): how many bytes; None reads to the end.
        """
        kept = desc.kept
        if kept is not None:
            if kept.error is not None:
                raise kept.error
            end = None if size is None else offset + size
            view = (
                kept.data if raw or kept.rendering is None else kept.rendering
            )
            return view[offset:end]
        return syscall(self._adapter.read)(
            desc.path, offset=offset, size=size, raw=raw
        )

    def _opened(self, path: str, facts: OpenMode) -> Descriptor:
        """A descriptor on ``path`` once the open's effect landed. Nothing
        is read at open: its handle fetches what a read lands in.

        Args:
            path (str): the mounted path.
            facts (OpenMode): what the open asked for.
        """
        # What other descriptors on the file still owe lands first, so
        # their older writes never land over what this one writes.
        if facts.writable:
            self.land_path(path)
        row = apply_open(self._adapter, path, facts)
        desc = Descriptor(self.walked(path), facts)
        desc.handle = FileHandle.opened(
            path,
            None
            if row is None
            else functools.partial(self._fetch, desc, facts.writable),
            size=0 if row is None else row.size,
            writable=facts.writable,
            append=facts.append,
        )
        return desc

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
        directory = row is not None and row.is_dir
        if directory and not (facts.writable or facts.create):
            desc = Descriptor(self.walked(path), facts)
        else:
            desc = self._opened(path, facts)
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
        streams over an unnumbered descriptor, so everything a file object
        offers behaves as on disk, but ``fileno``, which has nothing to
        answer. The arguments are checked before the open lands.

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
        key = id(desc)
        self._unnumbered[key] = desc
        raw = HandleRaw(
            cast(FileHandle, desc.handle),
            facts.readable,
            facts.writable,
            raw_mode(facts),
            functools.partial(self.land, desc),
            release=functools.partial(self._forget, key),
        )
        return layered(raw, facts, mode, encoding, errors, newline, buffering)

    def _forget(self, key: int) -> None:
        """Drop an unnumbered descriptor once its file object closed.

        Args:
            key (int): its key in the unnumbered table.
        """
        self._unnumbered.pop(key, None)

    def land(self, desc: Descriptor) -> None:
        """Land a descriptor's writes on the mount; one whose name went
        lands them on what its file kept, which every other descriptor on
        it reads, as writes to an unlinked file stay with it.

        Args:
            desc (Descriptor): the descriptor.
        """
        handle = desc.handle
        if handle is None:
            return
        if desc.kept is not None:
            if handle.dirty:
                desc.kept.data = apply_flush(
                    desc.kept.data, handle.flush_plan()
                )
                handle.settle(functools.partial(self._fetch, desc, True))
            return
        steps = handle.flush_plan()
        if not steps:
            return
        syscall(self._adapter.flush)(desc.path, steps)
        handle.settle(functools.partial(self._fetch, desc, True))

    def land_path(self, path: str, follow: bool = True) -> None:
        """Land the writes of every file open on ``path``, which a change
        of its times must come after.

        Args:
            path (str): the mounted path.
            follow (bool): the change follows a link at ``path``.
        """
        path = self.walked(path, follow)
        for desc in self._every():
            if desc.path == path:
                self.land(desc)

    def moved(self, old: str, new: str) -> None:
        """Follow a rename: a file open on ``old`` or under it is at ``new``
        now.

        Args:
            old (str): the path the rename took.
            new (str): the path it gave.
        """
        old, new = self.walked(old, False), self.walked(new, False)
        under = old.rstrip("/") + "/"
        for desc in self._every():
            if desc.kept is None and (
                desc.path == old or desc.path.startswith(under)
            ):
                desc.path = new + desc.path[len(old) :]

    def hold(self, path: str) -> list[tuple[Descriptor, Kept]]:
        """Read what the files open on ``path`` need before its name is
        removed or replaced; ``keep`` them once it has gone. They share
        what ``RuntimeFiles.kept`` reads, so a read that fails (a policy
        refusing it, say) still lets the removal it allows go ahead.

        Args:
            path (str): the path about to go.
        """
        path = self.walked(path, False)
        held = [
            desc
            for desc in self._every()
            if desc.path == path
            and desc.kept is None
            and desc.handle is not None
        ]
        if not held:
            return []
        # A descriptor that cannot read needs nothing kept for it.
        kept = syscall(self._adapter.kept)(
            path,
            stored=any(
                desc.facts.writable and desc.facts.readable for desc in held
            ),
            rendered=any(
                desc.facts.readable and not desc.facts.writable
                for desc in held
            ),
        )
        return [(desc, kept) for desc in held]

    @staticmethod
    def keep(held: list[tuple[Descriptor, Kept]]) -> None:
        """Detach the descriptors ``hold`` read for, now their name went.

        Args:
            held (list[tuple[Descriptor, Kept]]): what ``hold`` returned.
        """
        for desc, kept in held:
            desc.kept = kept

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
        desc = self[fd]
        if desc.handle is None:
            raise fs_error(desc.path, FsCondition.EISDIR)
        facts = parse_mode(mode)
        encoding = text_encoding(facts, encoding, errors, newline, buffering)
        raw = HandleRaw(
            desc.handle,
            facts.readable and desc.facts.readable,
            facts.writable and desc.facts.writable,
            raw_mode(facts),
            functools.partial(self.land, desc),
            lambda: self._open.get(fd) is desc,
            functools.partial(self.close, fd) if closefd else None,
            fd,
        )
        return layered(raw, facts, mode, encoding, errors, newline, buffering)

    def file(self, fd: int, want_read: bool, want_write: bool) -> FileHandle:
        """The handle a read or a write through ``fd`` uses.

        Args:
            fd (int): a mounted descriptor.
            want_read (bool): the call reads.
            want_write (bool): the call writes.
        """
        desc = self[fd]
        if desc.handle is None:
            raise fs_error(desc.path, FsCondition.EISDIR)
        if (want_read and not desc.facts.readable) or (
            want_write and not desc.facts.writable
        ):
            raise fs_error(desc.path, FsCondition.EBADF)
        return desc.handle
