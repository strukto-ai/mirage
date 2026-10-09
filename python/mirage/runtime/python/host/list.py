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

import os
from collections.abc import Iterator
from stat import S_ISDIR, S_ISLNK, S_ISREG
from typing import Any, Protocol

from mirage.runtime.python.host.stat import ident


class StatRouter(Protocol):
    """What a listed entry stats through: the patched `os`."""

    def stat(self, path: Any) -> os.stat_result: ...

    def lstat(self, path: Any) -> os.stat_result: ...


def leaf(entry: str) -> str:
    """The basename of a readdir entry, directory slash dropped.

    Args:
        entry (str): one entry as the readdir op spells it.
    """
    return entry.rstrip("/").rsplit("/", 1)[-1]


class MountDirEntry:
    """One `os.scandir` entry for a mounted directory.

    Carries the same surface CPython's DirEntry does, because
    ``os.walk``, ``glob`` and ``shutil`` read exactly these methods. The
    kind is decided by the stat the readdir just populated the index
    with, never by the name, with one exception: a backend that marks
    directories with a trailing slash has already answered, so the slash
    is taken as proof and saves the round trip.

    Args:
        router (StatRouter): the patched ``os`` to stat through.
        path (str): the entry's own virtual path.
        marked_dir (bool): the readdir listing slash-marked this entry.
    """

    __slots__ = ("_router", "_path", "_marked", "_stat", "_lstat")

    def __init__(
        self, router: StatRouter, path: str, marked_dir: bool
    ) -> None:
        self._router = router
        self._path = path
        self._marked = marked_dir
        self._stat: os.stat_result | None = None
        self._lstat: os.stat_result | None = None

    def __repr__(self) -> str:
        return f"<DirEntry {self.name!r}>"

    def __fspath__(self) -> str:
        return self._path

    @property
    def name(self) -> str:
        return leaf(self._path)

    @property
    def path(self) -> str:
        return self._path

    def inode(self) -> int:
        return ident(self._path)

    def stat(self, *, follow_symlinks: bool = True) -> os.stat_result:
        """The entry's stat, cached per direction as CPython's is.

        Args:
            follow_symlinks (bool): stat the target rather than the link.
        """
        if not follow_symlinks:
            if self._lstat is None:
                self._lstat = self._router.lstat(self._path)
            return self._lstat
        if self._stat is None:
            self._stat = self._router.stat(self._path)
        return self._stat

    def is_dir(self, *, follow_symlinks: bool = True) -> bool:
        if self._marked and follow_symlinks:
            return True
        return S_ISDIR(self.stat(follow_symlinks=follow_symlinks).st_mode)

    def is_file(self, *, follow_symlinks: bool = True) -> bool:
        if self._marked and follow_symlinks:
            return False
        return S_ISREG(self.stat(follow_symlinks=follow_symlinks).st_mode)

    def is_symlink(self) -> bool:
        if self._marked:
            return False
        return S_ISLNK(self.stat(follow_symlinks=False).st_mode)

    def is_junction(self) -> bool:
        return False


def entry_is_dir(entry: MountDirEntry) -> bool:
    """Whether a walked entry is a directory, False when it cannot say.

    CPython's own rule inside ``os.walk``: a stat that fails leaves the
    entry a non-directory, the same answer ``os.path.isdir`` gives. A
    broken link is the case that matters here, because following it to
    stat raises and would otherwise end the whole walk.

    Args:
        entry (MountDirEntry): the listed entry.
    """
    try:
        return entry.is_dir()
    except OSError:
        return False


def entry_is_link(entry: MountDirEntry) -> bool:
    """Whether a walked entry is a symlink, False when it cannot say.

    Args:
        entry (MountDirEntry): the listed entry.
    """
    try:
        return entry.is_symlink()
    except OSError:
        return False


class MountScandir:
    """`os.scandir`'s return value: an iterator that is also a context
    manager, which is how ``os.walk`` and ``glob`` consume it.

    Args:
        entries (list[MountDirEntry]): the listing, already resolved.
    """

    __slots__ = ("_entries",)

    def __init__(self, entries: list[MountDirEntry]) -> None:
        self._entries: Iterator[MountDirEntry] = iter(entries)

    def __iter__(self) -> "MountScandir":
        return self

    def __next__(self) -> MountDirEntry:
        return next(self._entries)

    def __enter__(self) -> "MountScandir":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._entries = iter(())
