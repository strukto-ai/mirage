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
import errno
import genericpath
import os as _real_os
import posixpath
import time
import types
from collections.abc import Awaitable, Callable, Iterator
from hashlib import blake2b
from stat import S_ISDIR, S_ISLNK, S_ISREG
from typing import Any, TypeVar, cast

from mirage.bridge.sync import run_async_from_sync
from mirage.errors import FsCondition
from mirage.errors.posix import gnu_phrase, posix_errno
from mirage.ops import Ops
from mirage.ops.host_io import in_host_io
from mirage.runtime.verbs import REFUSED_VERBS, ROUTED_VERBS
from mirage.types import FileStat
from mirage.utils.dates import iso_timestamp, timestamp_iso
from mirage.utils.path import owner_prefix
from mirage.utils.stat_view import LINK_MODE, content_size, is_dir, posix_mode

T = TypeVar("T")

# The block size every mirage stat translator reports; a backend has no
# block size of its own, and 4 KiB is what the FUSE adapters already
# answer.
_BLKSIZE = 4096


def _ident(text: str) -> int:
    """A stable, distinct id for one name.

    ``os.path.samefile`` compares (st_dev, st_ino) pairs and
    ``os.path.ismount`` compares a path's pair with its parent's, so
    reporting zero for both would make every mounted file the same file
    and every mount root invisible. Derived from the name rather than
    counted, so two processes reading the same workspace agree and a
    repeated stat of one path does not move.

    Args:
        text (str): the virtual path or mount prefix to identify.
    """
    return int.from_bytes(
        blake2b(text.encode(), digest_size=7).digest(), "big")


# setxattr(2)'s flags as linux numbers them, the one platform whose os
# module has the xattr family for this router to install.
_XATTR_CREATE = 1
_XATTR_REPLACE = 2


def _leaf(entry: str) -> str:
    """The basename of a readdir entry, directory slash dropped.

    Args:
        entry (str): one entry as the readdir op spells it.
    """
    return entry.rstrip("/").rsplit("/", 1)[-1]


def _spelled(path: Any) -> str | None:
    """`path` as the str a mount could serve, or None.

    A descriptor is not a path at all and a bytes path is a host
    spelling no mount uses, so both answer None and stay with the host.

    Args:
        path (Any): whatever the caller passed in the path slot.
    """
    if isinstance(path, int):
        return None
    try:
        spelled = _real_os.fspath(path)
    except TypeError:
        return None
    return spelled if isinstance(spelled, str) else None


class _MountDirEntry:
    """One `os.scandir` entry for a mounted directory.

    Carries the same surface CPython's DirEntry does, because
    ``os.walk``, ``glob`` and ``shutil`` read exactly these methods. The
    kind is decided by the stat the readdir just populated the index
    with, never by the name, with one exception: a backend that marks
    directories with a trailing slash has already answered, so the slash
    is taken as proof and saves the round trip.

    Args:
        router (_OsRouter): the door to stat through.
        path (str): the entry's own virtual path.
        marked_dir (bool): the readdir listing slash-marked this entry.
    """

    __slots__ = ("_router", "_path", "_marked", "_stat", "_lstat")

    def __init__(self, router: "_OsRouter", path: str,
                 marked_dir: bool) -> None:
        self._router = router
        self._path = path
        self._marked = marked_dir
        self._stat: _real_os.stat_result | None = None
        self._lstat: _real_os.stat_result | None = None

    def __repr__(self) -> str:
        return f"<DirEntry {self.name!r}>"

    def __fspath__(self) -> str:
        return self._path

    @property
    def name(self) -> str:
        return _leaf(self._path)

    @property
    def path(self) -> str:
        return self._path

    def inode(self) -> int:
        return _ident(self._path)

    def stat(self, *, follow_symlinks: bool = True) -> _real_os.stat_result:
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


def _entry_is_dir(entry: _MountDirEntry) -> bool:
    """Whether a walked entry is a directory, False when it cannot say.

    CPython's own rule inside ``os.walk``: a stat that fails leaves the
    entry a non-directory, the same answer ``os.path.isdir`` gives. A
    broken link is the case that matters here, because following it to
    stat raises and would otherwise end the whole walk.

    Args:
        entry (_MountDirEntry): the listed entry.
    """
    try:
        return entry.is_dir()
    except OSError:
        return False


def _entry_is_link(entry: _MountDirEntry) -> bool:
    """Whether a walked entry is a symlink, False when it cannot say.

    Args:
        entry (_MountDirEntry): the listed entry.
    """
    try:
        return entry.is_symlink()
    except OSError:
        return False


class _MountScandir:
    """`os.scandir`'s return value: an iterator that is also a context
    manager, which is how ``os.walk`` and ``glob`` consume it.

    Args:
        entries (list[_MountDirEntry]): the listing, already resolved.
    """

    __slots__ = ("_entries", )

    def __init__(self, entries: list[_MountDirEntry]) -> None:
        self._entries: Iterator[_MountDirEntry] = iter(entries)

    def __iter__(self) -> "_MountScandir":
        return self

    def __next__(self) -> _MountDirEntry:
        return next(self._entries)

    def __enter__(self) -> "_MountScandir":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._entries = iter(())


class _OsRouter:
    """Every routed `os` verb, answered on a mount or left to the host.

    One method per name in ``ROUTED_VERBS``; the table, not this class,
    decides which names exist, and ``make_os_module`` installs them by
    that table so a verb classified as routed cannot be left pointing at
    the host by omission. A path no mount owns falls through to the real
    function: the host process still needs its own filesystem, and the
    confinement story is the sandboxed runtimes, not this patch.

    Two conventions worth stating once. A ``dir_fd`` is ignored for a
    mounted path, which is what openat(2) says for an absolute one, and
    a mounted path is always absolute. And a mode argument at create
    time (``mkdir``) is dropped rather than stored: a backend has no
    permission bits of its own, so the overlay is reserved for an
    explicit chmod, where the guest asked for exactly that.

    Args:
        ops (Ops): the workspace door.
        loop (asyncio.AbstractEventLoop | None): the loop the door's
            coroutines run on; None gives each call a throwaway loop.
    """

    def __init__(self, ops: Ops,
                 loop: asyncio.AbstractEventLoop | None) -> None:
        self._ops = ops
        self._loop = loop
        # The host functions as they were when this router was built.
        # `patch_process` installs these wrappers onto the real os
        # module itself, so a wrapper that read `os.listdir` at call
        # time would find itself and recurse; the snapshot is what a
        # fall-through calls instead.
        self._host = types.SimpleNamespace(**vars(_real_os))
        # One stamp for this module's life, the same choice MountCore
        # makes for a mount's: a backend that reports no mtime would
        # otherwise answer a different time on every stat, and every
        # "did it change?" heuristic (make, rsync, importlib) fires on
        # that.
        self._now = time.time()
        # Windows has no getuid/getgid, and the ids are irrelevant
        # there; mirrors fuse/core.py.
        self._uid = (_real_os.getuid() if hasattr(_real_os, "getuid") else 0)
        self._gid = (_real_os.getgid() if hasattr(_real_os, "getgid") else 0)

    def _run(self, coro: Awaitable[T]) -> T:
        return run_async_from_sync(coro, self._loop)

    def _virtual(self, path: Any) -> str | None:
        """The mounted virtual path this argument names, else None.

        A backend serving an op is answered None whatever it spelled:
        the path it is reaching for is a physical one, and on a disk
        mount rooted at its own prefix the two spellings are the same
        string. Routing it would hand the op back to the backend that
        is running it (see ``ops/host_io.py``).

        Args:
            path (Any): whatever the caller passed in the path slot.
        """
        spelled = _spelled(path)
        if spelled is None or in_host_io():
            return None
        return spelled if self._ops.is_mounted(spelled) else None

    def _writable(self, virtual: str) -> bool:
        """Whether the mount owning `virtual` takes writes.

        The owner is resolved over every prefix and only then looked up
        among the writable ones: resolving over the writable subset
        instead let the catch-all root mount answer for a path a
        read-only mount owns, so a read-only mount reported W_OK.

        Args:
            virtual (str): the mounted virtual path.
        """
        owner = owner_prefix(self._ops.mount_prefixes(), virtual)
        if owner is None:
            return False
        return any(prefix == owner
                   for prefix, _ in self._ops.writable_mounts())

    def _result(self, virtual: str, mode: int, size: int, nlink: int,
                uid: int | str | None, gid: int | str | None,
                atime: float | None,
                mtime: float | None) -> _real_os.stat_result:
        """One `os.stat_result` from the fields a FileStat carries.

        Every optional field is filled explicitly, because built from a
        plain 10-tuple they come back None while still answering
        ``hasattr``: ``shutil.copystat`` reads ``st_flags`` that way and
        handed the host's chflags a None, and ``pathlib`` reads the
        ``_ns`` pair. A key the platform has no such field for
        (``st_flags`` off BSD) is dropped by the constructor, so the
        result carries exactly what a real stat there would.

        Args:
            virtual (str): the path being statted (the inode's name).
            mode (int): st_mode, type bits included.
            size (int): st_size.
            nlink (int): st_nlink.
            uid (int | str | None): owner from the overlay; a name or
                None falls back to the host's own uid.
            gid (int | str | None): group, read the same way.
            atime (float | None): access time, None for unknown.
            mtime (float | None): modification time, None for unknown.
        """
        stamp = self._now if mtime is None else mtime
        access = stamp if atime is None else atime
        prefix = owner_prefix(self._ops.mount_prefixes(), virtual) or "/"
        return _real_os.stat_result(
            (mode, _ident(virtual), _ident(prefix), nlink,
             uid if isinstance(uid, int) else self._uid,
             gid if isinstance(gid, int) else self._gid, size, int(access),
             int(stamp), int(stamp)), {
                 "st_atime": access,
                 "st_mtime": stamp,
                 "st_ctime": stamp,
                 "st_atime_ns": int(access * 1_000_000_000),
                 "st_mtime_ns": int(stamp * 1_000_000_000),
                 "st_ctime_ns": int(stamp * 1_000_000_000),
                 "st_birthtime": stamp,
                 "st_blksize": _BLKSIZE,
                 "st_blocks": -(-size // 512),
                 "st_rdev": 0,
                 "st_flags": 0,
                 "st_gen": 0,
             })

    def _stat_of(self, virtual: str, st: FileStat) -> _real_os.stat_result:
        return self._result(virtual, posix_mode(st), content_size(st),
                            2 if is_dir(st) else 1, st.uid, st.gid,
                            iso_timestamp(st.atime),
                            iso_timestamp(st.modified))

    def _link_target(self, virtual: str) -> str | None:
        """The stored target when `virtual` is a link, else None.

        Args:
            virtual (str): the path to probe.
        """
        try:
            return str(self._run(self._ops.readlink(virtual)))
        except OSError as exc:
            # EINVAL is the door's "there, but not a link". A missing
            # path raises ENOENT instead, exactly as readlink(2) does,
            # and that is the answer lstat owes its caller, so it is not
            # swallowed here.
            if exc.errno == errno.EINVAL:
                return None
            raise

    def _exists(self, virtual: str) -> bool:
        try:
            self._run(self._ops.stat(virtual))
            return True
        except (OSError, ValueError):
            return False

    def _isdir(self, virtual: str) -> bool:
        try:
            return is_dir(self._run(self._ops.stat(virtual)))
        except (OSError, ValueError):
            return False

    def listdir(self, path: Any = None) -> list[str] | list[bytes]:
        """The names in a directory, as the host spells them off a mount.

        The union is the real signature: a bytes path never reaches a
        mount, and the host answers one of those with bytes names.

        Args:
            path (Any): the directory to list, cwd when omitted.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(list[str] | list[bytes], self._host.listdir(path))
        return [
            _leaf(entry) for entry in self._run(self._ops.readdir(virtual))
        ]

    def scandir(self, path: Any = None) -> Any:
        """The directory as lazily-stattable entries.

        The return type is left open because the two branches answer
        different concrete iterators and CPython's own is not a name
        typeshed exports; both satisfy what a caller reads from one.

        Args:
            path (Any): the directory to list, cwd when omitted.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return self._host.scandir(path)
        entries = [
            _MountDirEntry(self, entry.rstrip("/"), entry.endswith("/"))
            for entry in self._run(self._ops.readdir(virtual))
        ]
        return _MountScandir(entries)

    def walk(self,
             top: Any,
             topdown: bool = True,
             onerror: Callable[[OSError], None] | None = None,
             followlinks: bool = False) -> Iterator[Any]:
        """Walk a tree, yielding (top, dirs, files) per directory.

        Args:
            top (Any): the directory to start from.
            topdown (bool): yield a directory before its children.
            onerror (Callable | None): receives a listing OSError.
            followlinks (bool): descend into a link to a directory.
        """
        virtual = self._virtual(top)
        if virtual is None:
            yield from self._host.walk(top, topdown, onerror, followlinks)
            return
        yield from self._walk(virtual, topdown, onerror, followlinks)

    def _walk(self, top: str, topdown: bool,
              onerror: Callable[[OSError], None] | None,
              followlinks: bool) -> Iterator[tuple[str, list[str], list[str]]]:
        """One directory of a mounted walk, then its subdirectories.

        CPython's own shape: the listing error goes to ``onerror`` and
        prunes that branch, ``dirs`` is yielded before it is descended
        so a topdown caller can edit it, and a link to a directory is
        listed as a directory but not entered unless ``followlinks``.

        Args:
            top (str): the directory to list.
            topdown (bool): yield a directory before its children.
            onerror (Callable | None): receives a listing OSError.
            followlinks (bool): descend into a link to a directory.
        """
        try:
            entries = list(self.scandir(top))
        except OSError as exc:
            if onerror is not None:
                onerror(exc)
            return
        dirs: list[str] = []
        files: list[str] = []
        links: set[str] = set()
        for entry in entries:
            if not _entry_is_dir(entry):
                files.append(entry.name)
                continue
            dirs.append(entry.name)
            if _entry_is_link(entry):
                links.add(entry.name)
        if topdown:
            yield top, dirs, files
        for name in list(dirs):
            if name in links and not followlinks:
                continue
            yield from self._walk(posixpath.join(top, name), topdown, onerror,
                                  followlinks)
        if not topdown:
            yield top, dirs, files

    def stat(self,
             path: Any,
             *,
             dir_fd: int | None = None,
             follow_symlinks: bool = True) -> _real_os.stat_result:
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                _real_os.stat_result,
                self._host.stat(path,
                                dir_fd=dir_fd,
                                follow_symlinks=follow_symlinks))
        if not follow_symlinks:
            return self.lstat(virtual)
        return self._stat_of(virtual, self._run(self._ops.stat(virtual)))

    def lstat(self,
              path: Any,
              *,
              dir_fd: int | None = None) -> _real_os.stat_result:
        """Stat without following, so a link reports as itself.

        The node table is asked first because a link is namespace state
        that no backend can see: a stat alone would silently answer for
        the target, and a broken link would read as absent. The readlink
        probe is what asks, so the door's visibility gate decides
        whether the link is there at all; the row behind it is then read
        straight off the table, because it carries what a ``chown -h``
        wrote and rebuilding the answer from the target string alone
        reported the process defaults instead.

        Args:
            path (Any): the path to stat.
            dir_fd (int | None): honored only off a mount.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(_real_os.stat_result,
                        self._host.lstat(path, dir_fd=dir_fd))
        target = self._link_target(virtual)
        if target is None:
            return self._stat_of(virtual, self._run(self._ops.stat(virtual)))
        links = self._ops.links
        row = None if links is None else links.link_stat_at(virtual)
        if row is None:
            # A facade built without a link table: the target string is
            # the only fact there is.
            return self._result(virtual, LINK_MODE, len(target.encode()), 1,
                                None, None, None, None)
        return self._stat_of(virtual, row)

    def access(self,
               path: Any,
               mode: int,
               *,
               dir_fd: int | None = None,
               effective_ids: bool = False,
               follow_symlinks: bool = True) -> bool:
        """Whether the caller may reach `path` the requested way.

        Read is granted by existence and write by the owning mount's
        mode, because a mount mode is mirage's access control and the
        permission bits a backend has none of are cosmetic. Execute is
        the one question the bits answer, so it reads them. A session's
        own narrower grant is enforced at the door when the write
        actually happens, exactly as POSIX leaves access(2) advisory.

        Args:
            path (Any): the path to test.
            mode (int): F_OK, or R_OK/W_OK/X_OK or'd together.
            dir_fd (int | None): honored only off a mount.
            effective_ids (bool): honored only off a mount.
            follow_symlinks (bool): test the target, not the link.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                bool,
                self._host.access(path,
                                  mode,
                                  dir_fd=dir_fd,
                                  effective_ids=effective_ids,
                                  follow_symlinks=follow_symlinks))
        try:
            st = self.stat(virtual, follow_symlinks=follow_symlinks)
        except OSError:
            return False
        if mode & _real_os.W_OK and not self._writable(virtual):
            return False
        if mode & _real_os.X_OK and not st.st_mode & 0o111:
            return False
        return True

    def chmod(self,
              path: Any,
              mode: int,
              *,
              dir_fd: int | None = None,
              follow_symlinks: bool = True) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.chmod(path,
                             mode,
                             dir_fd=dir_fd,
                             follow_symlinks=follow_symlinks)
            return
        self._run(
            self._ops.setattr(virtual, mode=mode,
                              nofollow=not follow_symlinks))

    def chown(self,
              path: Any,
              uid: int,
              gid: int,
              *,
              dir_fd: int | None = None,
              follow_symlinks: bool = True) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.chown(path,
                             uid,
                             gid,
                             dir_fd=dir_fd,
                             follow_symlinks=follow_symlinks)
            return
        # -1 is POSIX's "leave this one alone", which the door spells
        # None; passing it through would store an id of -1.
        self._run(
            self._ops.setattr(virtual,
                              uid=None if uid == -1 else uid,
                              gid=None if gid == -1 else gid,
                              nofollow=not follow_symlinks))

    def getxattr(self,
                 path: Any,
                 attribute: str | bytes,
                 *,
                 follow_symlinks: bool = True) -> bytes:
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                bytes,
                self._host.getxattr(path,
                                    attribute,
                                    follow_symlinks=follow_symlinks))
        return bytes(
            self._run(
                self._ops.getxattr(virtual,
                                   _real_os.fsdecode(attribute),
                                   nofollow=not follow_symlinks)))

    def listxattr(self,
                  path: Any = None,
                  *,
                  follow_symlinks: bool = True) -> list[str]:
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                list[str],
                self._host.listxattr(path, follow_symlinks=follow_symlinks))
        return list(
            self._run(
                self._ops.listxattr(virtual, nofollow=not follow_symlinks)))

    def setxattr(self,
                 path: Any,
                 attribute: str | bytes,
                 value: bytes,
                 flags: int = 0,
                 *,
                 follow_symlinks: bool = True) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.setxattr(path,
                                attribute,
                                value,
                                flags,
                                follow_symlinks=follow_symlinks)
            return
        self._run(
            self._ops.setxattr(virtual,
                               _real_os.fsdecode(attribute),
                               bytes(value),
                               create=bool(flags & _XATTR_CREATE),
                               replace=bool(flags & _XATTR_REPLACE),
                               nofollow=not follow_symlinks))

    def removexattr(self,
                    path: Any,
                    attribute: str | bytes,
                    *,
                    follow_symlinks: bool = True) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.removexattr(path,
                                   attribute,
                                   follow_symlinks=follow_symlinks)
            return
        self._run(
            self._ops.removexattr(virtual,
                                  _real_os.fsdecode(attribute),
                                  nofollow=not follow_symlinks))

    def lchmod(self, path: Any, mode: int) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.lchmod(path, mode)
            return
        self.chmod(virtual, mode, follow_symlinks=False)

    def lchown(self, path: Any, uid: int, gid: int) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.lchown(path, uid, gid)
            return
        self.chown(virtual, uid, gid, follow_symlinks=False)

    def utime(self,
              path: Any,
              times: tuple[float, float] | None = None,
              *,
              ns: tuple[int, int] | None = None,
              dir_fd: int | None = None,
              follow_symlinks: bool = True) -> None:
        """Set the access and modification times, now by default.

        Args:
            path (Any): the path to stamp.
            times (tuple[float, float] | None): (atime, mtime) seconds.
            ns (tuple[int, int] | None): the same pair in nanoseconds.
            dir_fd (int | None): honored only off a mount.
            follow_symlinks (bool): stamp the target, not the link.
        """
        if ns is not None and times is not None:
            raise ValueError(
                "utime: you may specify either 'times' or 'ns' but not both")
        virtual = self._virtual(path)
        if virtual is None:
            # `ns=None` is not the same as an absent `ns` to the real
            # utime: it type-checks the tuple before reading `times`.
            if ns is None:
                self._host.utime(path,
                                 times,
                                 dir_fd=dir_fd,
                                 follow_symlinks=follow_symlinks)
            else:
                self._host.utime(path,
                                 ns=ns,
                                 dir_fd=dir_fd,
                                 follow_symlinks=follow_symlinks)
            return
        if ns is not None:
            access, stamp = (value / 1_000_000_000 for value in ns)
        elif times is not None:
            access, stamp = (float(value) for value in times)
        else:
            access = stamp = time.time()
        self._run(
            self._ops.setattr(virtual,
                              atime=timestamp_iso(access),
                              mtime=timestamp_iso(stamp),
                              nofollow=not follow_symlinks))

    def mkdir(self,
              path: Any,
              mode: int = 0o777,
              *,
              dir_fd: int | None = None) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.mkdir(path, mode, dir_fd=dir_fd)
            return
        self._run(self._ops.mkdir(virtual))

    def makedirs(self,
                 name: Any,
                 mode: int = 0o777,
                 exist_ok: bool = False) -> None:
        """Create a directory and every missing ancestor.

        The ancestors are walked here because the mkdir op is one level
        on the backends that have their own (an object store creates a
        marker, not a chain), so a single dispatch would leave the
        middle of the path unlisted.

        Args:
            name (Any): the directory to create.
            mode (int): dropped, as for mkdir.
            exist_ok (bool): stay quiet when the leaf is already there.
        """
        virtual = self._virtual(name)
        if virtual is None:
            self._host.makedirs(name, mode, exist_ok=exist_ok)
            return
        # The walk stops at the mount root as well as at the first
        # ancestor that is already there: a mount root is the
        # deployment's own configuration and creating one is refused
        # (EBUSY), so a backend that does not stat its own root would
        # otherwise turn makedirs into that refusal.
        root = (owner_prefix(self._ops.mount_prefixes(), virtual)
                or "/").rstrip("/")
        missing: list[str] = []
        probe = virtual.rstrip("/")
        while (probe and probe != "/" and probe != root
               and not self._exists(probe)):
            missing.append(probe)
            probe = posixpath.dirname(probe)
        if not missing:
            if exist_ok and self._isdir(virtual):
                return
            raise FileExistsError(errno.EEXIST,
                                  _real_os.strerror(errno.EEXIST), virtual)
        for path in reversed(missing):
            self._run(self._ops.mkdir(path))

    def rmdir(self, path: Any, *, dir_fd: int | None = None) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.rmdir(path, dir_fd=dir_fd)
            return
        self._run(self._ops.rmdir(virtual))

    def removedirs(self, name: Any) -> None:
        """Remove a directory, then every parent that empties.

        Args:
            name (Any): the deepest directory to remove.
        """
        virtual = self._virtual(name)
        if virtual is None:
            self._host.removedirs(name)
            return
        self.rmdir(virtual)
        parent = posixpath.dirname(virtual.rstrip("/"))
        while parent and parent != "/":
            try:
                self.rmdir(parent)
            except OSError:
                # CPython's own contract: the walk up stops at the
                # first parent that will not go, and that is not an
                # error for the caller.
                break
            parent = posixpath.dirname(parent)

    def remove(self, path: Any, *, dir_fd: int | None = None) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.remove(path, dir_fd=dir_fd)
            return
        self._run(self._ops.unlink(virtual))

    def unlink(self, path: Any, *, dir_fd: int | None = None) -> None:
        self.remove(path, dir_fd=dir_fd)

    def rename(self,
               src: Any,
               dst: Any,
               *,
               src_dir_fd: int | None = None,
               dst_dir_fd: int | None = None) -> None:
        self._move(src, dst, src_dir_fd, dst_dir_fd, replace=False)

    def replace(self,
                src: Any,
                dst: Any,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None) -> None:
        self._move(src, dst, src_dir_fd, dst_dir_fd, replace=True)

    def _move(self, src: Any, dst: Any, src_dir_fd: int | None,
              dst_dir_fd: int | None, replace: bool) -> None:
        """Rename within the mounts or within the host, never across.

        One end on a mount and the other on the host is EXDEV, the same
        answer the kernel gives for two filesystems: nothing can move a
        name from one namespace to the other in one step, and EXDEV is
        the errno ``shutil.move`` already retries as copy-and-delete.
        ``replace`` and ``rename`` reach the same op, because what an
        existing destination does is the backend's rule, not this
        layer's.

        Args:
            src (Any): the source path.
            dst (Any): the destination path.
            src_dir_fd (int | None): honored only off a mount.
            dst_dir_fd (int | None): honored only off a mount.
            replace (bool): the caller spelled it ``os.replace``.
        """
        source, dest = self._virtual(src), self._virtual(dst)
        if source is None and dest is None:
            move = (self._host.replace if replace else self._host.rename)
            move(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
            return
        if source is None or dest is None:
            raise OSError(errno.EXDEV, _real_os.strerror(errno.EXDEV),
                          _spelled(src), None, _spelled(dst))
        self._run(self._ops.rename(source, dest))

    def renames(self, old: Any, new: Any) -> None:
        """Rename, creating the destination's parents and pruning the
        source's, which is what CPython's own renames does.

        Args:
            old (Any): the source path.
            new (Any): the destination path.
        """
        source, dest = self._virtual(old), self._virtual(new)
        if source is None and dest is None:
            self._host.renames(old, new)
            return
        if dest is not None:
            parent = posixpath.dirname(dest.rstrip("/"))
            if parent and not self._exists(parent):
                self.makedirs(parent, exist_ok=True)
        self._move(old, new, None, None, replace=False)
        if source is not None:
            head = posixpath.dirname(source.rstrip("/"))
            if head:
                try:
                    self.removedirs(head)
                except OSError:
                    # CPython ignores a parent that will not prune here
                    # too: the rename is what the caller asked for.
                    pass

    def symlink(self,
                src: Any,
                dst: Any,
                target_is_directory: bool = False,
                *,
                dir_fd: int | None = None) -> None:
        """Create a link at `dst` pointing at `src`.

        The gate is the link's own location, never its target: a link
        may point anywhere, including at a host path or at nothing, and
        the target is stored exactly as typed.

        Args:
            src (Any): what the link points to, kept verbatim.
            dst (Any): where the link is created.
            target_is_directory (bool): Windows-only, ignored here.
            dir_fd (int | None): honored only off a mount.
        """
        virtual = self._virtual(dst)
        if virtual is None:
            self._host.symlink(src, dst, target_is_directory, dir_fd=dir_fd)
            return
        self._run(self._ops.symlink(virtual, _real_os.fsdecode(src)))

    def readlink(self, path: Any, *, dir_fd: int | None = None) -> str | bytes:
        """The target a link holds, as the caller spelled the path.

        The union is CPython's own: ``os.readlink`` answers bytes for a
        bytes path, which is a host spelling no mount serves, so the
        host's answer is handed back untouched rather than coerced (a
        ``str()`` of it reads as ``"b'target'"``). A mounted path is
        always a str and the node table stores the target as one.

        Args:
            path (Any): the link to read.
            dir_fd (int | None): honored only off a mount.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(str | bytes, self._host.readlink(path, dir_fd=dir_fd))
        return str(self._run(self._ops.readlink(virtual)))

    def truncate(self, path: Any, length: int) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.truncate(path, length)
            return
        self._run(self._ops.truncate(virtual, length))


def _refusal(router: _OsRouter, verb: str,
             condition: FsCondition) -> Callable[..., Any]:
    """A wrapper that refuses `verb` on a mount and passes it through off one.

    The refusal carries the same condition every other mirage surface
    reports it with, so a guest sees one errno for one fact wherever it
    asked. Every argument is scanned rather than just the first, because
    the refused verbs put their paths in different slots (``link`` has
    two ends and ``listxattr`` has an optional one) and a non-path
    argument answers None on its own.

    Args:
        router (_OsRouter): the door, for its mount test.
        verb (str): the os name being wrapped.
        condition (FsCondition): what the table says to answer.
    """
    real = getattr(router._host, verb)

    def refuse(*args: Any, **kwargs: Any) -> Any:
        for value in (*args, *kwargs.values()):
            virtual = router._virtual(value)
            if virtual is not None:
                raise OSError(posix_errno(condition), gnu_phrase(condition),
                              virtual)
        return real(*args, **kwargs)

    return refuse


def _rebind(module: types.ModuleType,
            replacements: dict[str, Any]) -> types.ModuleType:
    """A copy of `module` whose functions read `replacements` as globals.

    ``os.path`` is a module of functions that call ``os.stat`` and
    ``os.lstat`` by global name, so a copy holding the patched os module
    routes every one of them at once: exists, isdir, islink, getsize,
    ismount, realpath, samefile. Naming them one by one instead means
    the list drifts, and the ones nobody remembered keep answering from
    the host about a path it has never had.

    Args:
        module (types.ModuleType): the module to copy.
        replacements (dict[str, Any]): globals to override in the copy.
    """
    copy = types.ModuleType(module.__name__)
    copy.__dict__.update(module.__dict__)
    copy.__dict__.update(replacements)
    for name, value in list(vars(module).items()):
        if (not isinstance(value, types.FunctionType)
                or value.__globals__ is not module.__dict__):
            continue
        rebound = types.FunctionType(value.__code__, copy.__dict__, name,
                                     value.__defaults__, value.__closure__)
        rebound.__kwdefaults__ = value.__kwdefaults__
        copy.__dict__[name] = rebound
    return copy


def os_routing(
    ops: Ops,
    loop: asyncio.AbstractEventLoop | None = None
) -> dict[str, Callable[..., Any]]:
    """Every `os` name that must not answer from the host, and what does.

    Built from ``runtime/verbs.py``, the decision every runtime surface
    shares: a routed name gets the workspace door, a refused name gets
    that table's errno on a mounted path, and a passthrough name is
    absent here because it is a program or a string, never a file. A
    name the host python does not have (``lchmod`` off macOS) is absent
    too, so ``hasattr`` still reports what it did before.

    The table is what makes the fix complete rather than a list someone
    maintains: ``os.walk`` reads ``os.scandir`` and ``os.path.exists``
    reads ``os.stat``, so one name left pointing at the host takes a
    whole family with it, which is how ten patched names left the rest
    of the module answering about paths it has never had.

    Args:
        ops (Ops): the workspace door.
        loop (asyncio.AbstractEventLoop | None): shared event loop.

    Returns:
        dict[str, Callable[..., Any]]: os name to replacement function.
    """
    router = _OsRouter(ops, loop)
    table: dict[str, Callable[..., Any]] = {}
    for verb in ROUTED_VERBS:
        if hasattr(_real_os, verb):
            table[verb] = getattr(router, verb)
    for verb, condition in REFUSED_VERBS.items():
        if hasattr(_real_os, verb):
            table[verb] = _refusal(router, verb, condition)
    return table


def make_os_module(
        ops: Ops,
        loop: asyncio.AbstractEventLoop | None = None) -> types.ModuleType:
    """A standalone copy of `os` that routes mounted paths.

    A copy, not a patch, for a caller that wants the routing without
    changing the process: hand it to a script's globals, or hold it in
    a test. ``patch_process`` uses ``os_routing`` on the real module
    instead, because a module already imported holds its own reference
    to that one and a copy would never reach it.

    Its ``path`` is a copy too, since ``os.path`` is a module of
    functions that read ``os`` from their own globals rather than from
    this copy.

    Args:
        ops (Ops): The ops instance with mount table.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.

    Returns:
        types.ModuleType: A patched os module.
    """
    patched = types.ModuleType("os")
    patched.__dict__.update(_real_os.__dict__)
    patched.__dict__.update(os_routing(ops, loop))
    generic = _rebind(genericpath, {"os": patched})
    shared = {name: generic.__dict__[name] for name in genericpath.__all__}
    patched.__dict__["path"] = _rebind(posixpath, {"os": patched, **shared})
    return patched
