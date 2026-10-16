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
import dataclasses
import errno
import functools
import genericpath
import logging
import os as _real_os
import posixpath
import shutil
import time
import types
from collections.abc import Callable, Iterator
from typing import Any, TypeVar, cast

from mirage.bridge.sync import run_async_from_sync
from mirage.errors import FsCondition
from mirage.errors.fs import ebusy, eexist, fs_error
from mirage.errors.posix import posix_errno, posix_phrase
from mirage.runtime.python.host.constants import (
    DESCRIPTOR_CALLS,
    REFUSED_CALLS,
    REFUSED_DESCRIPTOR_CALLS,
    ROUTED_CALLS,
    XATTR_CREATE,
    XATTR_REPLACE,
)
from mirage.runtime.python.host.descriptors import Descriptors
from mirage.runtime.python.host.host_io import in_host_io
from mirage.runtime.python.host.list import (
    MountDirEntry,
    MountScandir,
    entry_is_dir,
    entry_is_link,
)
from mirage.runtime.python.host.stat import stat_result
from mirage.runtime.python.host.syscall import as_raised, host_files, syscall
from mirage.runtime.stat import posix_stat
from mirage.runtime.types import VFSStat
from mirage.utils.dates import timestamp_iso
from mirage.utils.path import owner_prefix
from mirage.utils.remnants import entry_name
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)
T = TypeVar("T")


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


ErrorHandler = Callable[[Callable[..., Any], str, OSError], None]


def _ignored(func: Callable[..., Any], path: str, exc: OSError) -> None:
    return None


def _reraised(func: Callable[..., Any], path: str, exc: OSError) -> None:
    raise exc


def _rmtree_handler(
    ignore_errors: bool,
    onerror: Callable[..., None] | None,
    onexc: ErrorHandler | None,
) -> ErrorHandler:
    """What ``shutil.rmtree`` does with a failure, from its own arguments.

    Args:
        ignore_errors (bool): drop every failure.
        onerror (Callable[..., None] | None): the old handler, given
            ``sys.exc_info()``-shaped arguments.
        onexc (ErrorHandler | None): the handler given the exception,
            which wins over ``onerror``.
    """
    if ignore_errors:
        return _ignored
    if onexc is not None:
        return onexc
    if onerror is not None:
        handler = onerror
        return lambda func, path, exc: handler(
            func, path, (type(exc), exc, exc.__traceback__)
        )
    return _reraised


def _held(
    path: str, where: str, onexc: ErrorHandler, resolve: Callable[[str], str]
) -> bool:
    """Whether `path` still resolves where the walk found it.

    A directory swapped for a link, or under an ancestor that was, now
    resolves elsewhere, and a name under it would reach the link's
    target. shutil's descriptor walk reports that directory as a link
    and leaves it, and so does this one.

    Args:
        path (str): the directory the next call acts in.
        where (str): what it resolved to when the walk reached it.
        onexc (ErrorHandler): what a moved directory goes to.
        resolve (Callable[[str], str]): the namespace's follow, now.
    """
    try:
        if resolve(path) == where:
            return True
        raise OSError("Cannot call rmtree on a symbolic link")
    except OSError as err:
        onexc(_real_os.path.islink, path, err)
        return False


def _remove_tree(
    path: str, where: str, onexc: ErrorHandler, resolve: Callable[[str], str]
) -> None:
    """Remove a tree by name, children first, through the entry point's ``os``.

    The walk shutil keeps for a platform without descriptor calls, so a
    failure reaches ``onexc`` with the function and path shutil names.
    A name is all a mount gives, so before each call the directory it
    acts in is checked against where it resolved when the walk reached
    it, which is how a descriptor would have held it.

    Args:
        path (str): the directory to remove.
        where (str): what `path` resolved to when the walk reached it.
        onexc (ErrorHandler): what a failure goes to.
        resolve (Callable[[str], str]): the namespace's follow, now.
    """
    if not _held(path, where, onexc, resolve):
        return
    try:
        with _real_os.scandir(path) as listing:
            entries = list(listing)
    except OSError as err:
        onexc(_real_os.scandir, path, err)
        entries = []
    for entry in entries:
        try:
            is_dir = entry.is_dir(follow_symlinks=False)
        except OSError as err:
            # shutil's own fallback: an entry it cannot classify goes as
            # a file, and the unlink reports what is wrong with it.
            logger.debug("rmtree: classifying %s failed: %s", entry.path, err)
            is_dir = False
        if is_dir:
            child = posixpath.join(where, entry.name)
            _remove_tree(entry.path, child, onexc, resolve)
            continue
        if not _held(path, where, onexc, resolve):
            return
        try:
            _real_os.unlink(entry.path)
        except OSError as err:
            onexc(_real_os.unlink, entry.path, err)
    if not _held(path, where, onexc, resolve):
        return
    try:
        _real_os.rmdir(path)
    except OSError as err:
        onexc(_real_os.rmdir, path, err)


def make_rmtree(
    files: Files, loop: asyncio.AbstractEventLoop | None
) -> Callable[..., None]:
    """``shutil.rmtree``, walking a mounted tree by name.

    shutil removes a tree through descriptors where the platform has
    them, ``os.open`` on each directory and then ``os.scandir`` of the
    descriptor, and a mount has none: the entry point refuses ``os.open``, so
    every rmtree of a mounted path failed ENOTSUP. A mounted path is
    walked by name here instead, through ``os.scandir``, ``os.unlink``
    and ``os.rmdir`` like any other caller, while a host path keeps
    shutil's own descriptor walk: shutil's switch between the two is
    the whole process's, so flipping it would hand a host removal on
    another thread the walk a swapped link can lead astray. A tree
    holding a mount root, spelled however (``/data/.``), is refused
    (EBUSY) before anything goes, as node's entry point refuses it, and the
    refusal reaches ``onexc``, ``onerror`` or ``ignore_errors`` as any
    other failure does.

    The mounted walk asks the namespace, on the block's loop where its
    table changes, where each directory resolves before acting in it,
    so a directory swapped for a link is left rather than followed.
    That check and the call after it are two steps, not one descriptor,
    so ``avoids_symlink_attacks`` is False, the answer shutil itself
    gives where it walks by name.

    Args:
        files (Files): the workspace's ``ws.vfs``.
        loop (asyncio.AbstractEventLoop | None): the block's loop.
    """
    original = shutil.rmtree
    links = files._links

    async def follow(path: str) -> str:
        return posixpath.normpath(
            path if links is None else links.follow(path)
        )

    def resolve(path: str) -> str:
        return run_async_from_sync(follow(path), loop)

    @functools.wraps(original)
    def rmtree(path: Any, *args: Any, **kwargs: Any) -> None:
        spelled = _spelled(path)
        if (
            spelled is None
            or in_host_io()
            or kwargs.get("dir_fd") is not None
            or not files.is_mounted(spelled)
        ):
            original(path, *args, **kwargs)
            return
        onexc = _rmtree_handler(
            kwargs.get("ignore_errors", args[0] if args else False),
            kwargs.get("onerror", args[1] if len(args) > 1 else None),
            kwargs.get("onexc"),
        )
        root = posixpath.normpath(spelled).rstrip("/") or "/"
        held = files.submounts(root)
        if files.is_mount(root):
            held.append(root)
        if held:
            busy = max(held, key=len)
            onexc(_real_os.rmdir, busy, as_raised(ebusy(busy)))
            return
        try:
            if _real_os.path.islink(spelled):
                raise OSError("Cannot call rmtree on a symbolic link")
            where = resolve(spelled)
        except OSError as err:
            onexc(_real_os.path.islink, spelled, err)
            return
        _remove_tree(spelled, where, onexc, resolve)

    cast(Any, rmtree).avoids_symlink_attacks = False
    return rmtree


class HostFs:
    """Every routed `os` verb, answered on a mount or left to the host.

    One method per name in ``ROUTED_CALLS``; the table, not this class,
    decides which names exist, and ``make_os_module`` installs them by
    that table so a verb classified as routed cannot be left pointing at
    the host by omission. A path no mount owns falls through to the real
    function: the host process still needs its own filesystem, and the
    confinement story is the sandboxed runtimes, not this patch.

    Two conventions worth stating once. A ``dir_fd`` is ignored for a
    mounted path, which is what openat(2) says for an absolute one, and
    a mounted path is always absolute; a relative path under a mounted
    directory descriptor is resolved against it first (``_anchored``).
    And a mode argument at create
    time (``mkdir``) is dropped rather than stored: a backend has no
    permission bits of its own, so the overlay is reserved for an
    explicit chmod, where the guest asked for exactly that.

    Args:
        files (Files): the workspace's file API.
        loop (asyncio.AbstractEventLoop | None): the loop the file API's
            coroutines run on; None gives each call a throwaway loop.
    """

    def __init__(
        self, files: Files, loop: asyncio.AbstractEventLoop | None
    ) -> None:
        self._files = files
        self._adapter = host_files(files, loop)
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
        # there; mirrors mount/core.py.
        self._uid = _real_os.getuid() if hasattr(_real_os, "getuid") else 0
        self._gid = _real_os.getgid() if hasattr(_real_os, "getgid") else 0
        self._descriptors = Descriptors(
            self._adapter, self._host, files._links
        )

    @property
    def files(self) -> Files:
        """The workspace's file API this entry point answers through."""
        return self._files

    @property
    def descriptors(self) -> Descriptors:
        """The descriptors ``open`` handed out for mounted paths."""
        return self._descriptors

    def _virtual(self, path: Any) -> str | None:
        """The mounted virtual path this argument names, else None. A
        descriptor ``open`` handed out names the path it opened, so the
        calls that take one in the path slot (``stat``, ``chmod``,
        ``utime``) reach the mount.

        A backend serving an op is answered None whatever it spelled:
        the path it is reaching for is a physical one, and on a disk
        mount rooted at its own prefix the two spellings are the same
        string. Routing it would hand the op back to the backend that
        is running it (see ``host_io.py``).

        Args:
            path (Any): whatever the caller passed in the path slot.
        """
        if in_host_io():
            return None
        desc = self._descriptors.get(path)
        if desc is not None:
            return desc.path
        spelled = _spelled(path)
        if spelled is None:
            return None
        return spelled if self._files.is_mounted(spelled) else None

    def _writable(self, virtual: str) -> bool:
        """Whether the mount owning `virtual` takes writes.

        The owner is resolved over every prefix and only then looked up
        among the writable ones: resolving over the writable subset
        instead let the catch-all root mount answer for a path a
        read-only mount owns, so a read-only mount reported W_OK.

        Args:
            virtual (str): the mounted virtual path.
        """
        owner = owner_prefix(self._files.mount_prefixes(), virtual)
        if owner is None:
            return False
        return any(
            prefix == owner for prefix, _ in self._files.writable_mounts()
        )

    def _stat_of(
        self, virtual: str, st: VFSStat, unlinked: bool = False
    ) -> _real_os.stat_result:
        """One `os.stat_result` for a row, by the rule every runtime
        shares; an owner the row lacks is the host process's own.

        Args:
            virtual (str): the path being statted (the inode's name).
            st (VFSStat): the mount's row for it.
            unlinked (bool): the file has no name left, so no link.
        """
        posix = posix_stat(
            st,
            virtual,
            owner_prefix(self._files.mount_prefixes(), virtual) or "/",
            uid=self._uid,
            gid=self._gid,
            unknown_ns=int(self._now * 1_000_000_000),
        )
        return stat_result(
            dataclasses.replace(posix, nlink=0) if unlinked else posix
        )

    def _isdir(self, virtual: str) -> bool:
        """Whether ``virtual`` is a directory, absence reading as no.

        Args:
            virtual (str): the mounted path.
        """
        row = self._adapter.stat_or_none(virtual)
        return row is not None and row.is_dir

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
            entry_name(row.path)
            for row in self._adapter.readdir(virtual, classify=False)
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
            MountDirEntry(self, row.path.rstrip("/"), row.is_dir)
            for row in self._adapter.readdir(virtual, classify=False)
        ]
        return MountScandir(entries)

    def walk(
        self,
        top: Any,
        topdown: bool = True,
        onerror: Callable[[OSError], None] | None = None,
        followlinks: bool = False,
    ) -> Iterator[Any]:
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

    def _walk(
        self,
        top: str,
        topdown: bool,
        onerror: Callable[[OSError], None] | None,
        followlinks: bool,
    ) -> Iterator[tuple[str, list[str], list[str]]]:
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
            if not entry_is_dir(entry):
                files.append(entry.name)
                continue
            dirs.append(entry.name)
            if entry_is_link(entry):
                links.add(entry.name)
        if topdown:
            yield top, dirs, files
        for name in list(dirs):
            if name in links and not followlinks:
                continue
            yield from self._walk(
                posixpath.join(top, name), topdown, onerror, followlinks
            )
        if not topdown:
            yield top, dirs, files

    def stat(
        self,
        path: Any,
        *,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> _real_os.stat_result:
        if self._descriptors.get(path) is not None:
            return self.fstat(path)
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                _real_os.stat_result,
                self._host.stat(
                    path, dir_fd=dir_fd, follow_symlinks=follow_symlinks
                ),
            )
        if not follow_symlinks:
            return self.lstat(virtual)
        return self._stat_of(virtual, self._adapter.stat(virtual))

    def lstat(
        self, path: Any, *, dir_fd: int | None = None
    ) -> _real_os.stat_result:
        """Stat without following, so a link reports as itself.

        The row is the node table's own, so it carries what a ``chown -h``
        wrote, and the dispatcher gates the read as it gates ``readlink``.

        Args:
            path (Any): the path to stat.
            dir_fd (int | None): honored only off a mount.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                _real_os.stat_result, self._host.lstat(path, dir_fd=dir_fd)
            )
        return self._stat_of(
            virtual, self._adapter.stat(virtual, nofollow=True)
        )

    def access(
        self,
        path: Any,
        mode: int,
        *,
        dir_fd: int | None = None,
        effective_ids: bool = False,
        follow_symlinks: bool = True,
    ) -> bool:
        """Whether the caller may reach `path` the requested way.

        Read is granted by existence and write by the owning mount's
        mode, because a mount mode is mirage's access control and the
        permission bits a backend has none of are cosmetic. Execute is
        the one question the bits answer, so it reads them. A session's
        own narrower grant is enforced at the entry point when the write
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
                self._host.access(
                    path,
                    mode,
                    dir_fd=dir_fd,
                    effective_ids=effective_ids,
                    follow_symlinks=follow_symlinks,
                ),
            )
        try:
            st = self.stat(virtual, follow_symlinks=follow_symlinks)
        except OSError:
            return False
        if mode & _real_os.W_OK and not self._writable(virtual):
            return False
        if mode & _real_os.X_OK and not st.st_mode & 0o111:
            return False
        return True

    def chmod(
        self,
        path: Any,
        mode: int,
        *,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.chmod(
                path, mode, dir_fd=dir_fd, follow_symlinks=follow_symlinks
            )
            return
        self._adapter.setattr(virtual, mode=mode, nofollow=not follow_symlinks)

    def chown(
        self,
        path: Any,
        uid: int,
        gid: int,
        *,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.chown(
                path, uid, gid, dir_fd=dir_fd, follow_symlinks=follow_symlinks
            )
            return
        # -1 is POSIX's "leave this one alone", which the entry point spells
        # None; passing it through would store an id of -1.
        self._adapter.setattr(
            virtual,
            uid=None if uid == -1 else uid,
            gid=None if gid == -1 else gid,
            nofollow=not follow_symlinks,
        )

    def getxattr(
        self,
        path: Any,
        attribute: str | bytes,
        *,
        follow_symlinks: bool = True,
    ) -> bytes:
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                bytes,
                self._host.getxattr(
                    path, attribute, follow_symlinks=follow_symlinks
                ),
            )
        return bytes(
            self._adapter.call(
                "getxattr",
                virtual,
                name=_real_os.fsdecode(attribute),
                nofollow=not follow_symlinks,
            )
        )

    def listxattr(
        self, path: Any = None, *, follow_symlinks: bool = True
    ) -> list[str]:
        virtual = self._virtual(path)
        if virtual is None:
            return cast(
                list[str],
                self._host.listxattr(path, follow_symlinks=follow_symlinks),
            )
        return list(
            self._adapter.call(
                "listxattr", virtual, nofollow=not follow_symlinks
            )
        )

    def setxattr(
        self,
        path: Any,
        attribute: str | bytes,
        value: bytes,
        flags: int = 0,
        *,
        follow_symlinks: bool = True,
    ) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.setxattr(
                path, attribute, value, flags, follow_symlinks=follow_symlinks
            )
            return
        self._adapter.call(
            "setxattr",
            virtual,
            name=_real_os.fsdecode(attribute),
            value=bytes(value),
            create=bool(flags & XATTR_CREATE),
            replace=bool(flags & XATTR_REPLACE),
            nofollow=not follow_symlinks,
        )

    def removexattr(
        self,
        path: Any,
        attribute: str | bytes,
        *,
        follow_symlinks: bool = True,
    ) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.removexattr(
                path, attribute, follow_symlinks=follow_symlinks
            )
            return
        self._adapter.call(
            "removexattr",
            virtual,
            name=_real_os.fsdecode(attribute),
            nofollow=not follow_symlinks,
        )

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

    def utime(
        self,
        path: Any,
        times: tuple[float, float] | None = None,
        *,
        ns: tuple[int, int] | None = None,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
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
                "utime: you may specify either 'times' or 'ns' but not both"
            )
        virtual = self._virtual(path)
        if virtual is None:
            # `ns=None` is not the same as an absent `ns` to the real
            # utime: it type-checks the tuple before reading `times`.
            if ns is None:
                self._host.utime(
                    path, times, dir_fd=dir_fd, follow_symlinks=follow_symlinks
                )
            else:
                self._host.utime(
                    path, ns=ns, dir_fd=dir_fd, follow_symlinks=follow_symlinks
                )
            return
        if ns is not None:
            access, stamp = (value / 1_000_000_000 for value in ns)
        elif times is not None:
            access, stamp = (float(value) for value in times)
        else:
            access = stamp = time.time()
        # Writes a descriptor still owes land first, or landing them at
        # its close would stamp over the times set here.
        self._descriptors.land_path(virtual, follow_symlinks)
        self._adapter.setattr(
            virtual,
            atime=timestamp_iso(access),
            mtime=timestamp_iso(stamp),
            nofollow=not follow_symlinks,
        )

    def mkdir(
        self, path: Any, mode: int = 0o777, *, dir_fd: int | None = None
    ) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.mkdir(path, mode, dir_fd=dir_fd)
            return
        self._adapter.mkdir(virtual)

    def makedirs(
        self, name: Any, mode: int = 0o777, exist_ok: bool = False
    ) -> None:
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
        root = (
            owner_prefix(self._files.mount_prefixes(), virtual) or "/"
        ).rstrip("/")
        missing: list[str] = []
        probe = virtual.rstrip("/")
        while (
            probe
            and probe != "/"
            and probe != root
            and self._adapter.stat_or_none(probe) is None
        ):
            missing.append(probe)
            probe = posixpath.dirname(probe)
        if not missing:
            if exist_ok and self._isdir(virtual):
                return
            raise eexist(virtual)
        for path in reversed(missing):
            try:
                self._adapter.mkdir(path)
            except FileExistsError:
                # Another creator got there first, which an ancestor
                # shrugs off as CPython's makedirs does.
                if path == missing[0] and not (exist_ok and self._isdir(path)):
                    raise

    def rmdir(self, path: Any, *, dir_fd: int | None = None) -> None:
        virtual = self._virtual(path)
        if virtual is None:
            self._host.rmdir(path, dir_fd=dir_fd)
            return
        # rmdir(2) on a mount point is EBUSY. A mount root is the
        # deployment's own, which the shell's rm refuses the same way.
        owner = owner_prefix(self._files.mount_prefixes(), virtual)
        named = posixpath.normpath(virtual).rstrip("/")
        if owner is not None and owner.rstrip("/") == named:
            raise ebusy(virtual)
        self._adapter.rmdir(virtual)

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
        held = self._descriptors.hold(virtual)
        self._adapter.unlink(virtual)
        self._descriptors.keep(held)

    def unlink(self, path: Any, *, dir_fd: int | None = None) -> None:
        self.remove(path, dir_fd=dir_fd)

    def rename(
        self,
        src: Any,
        dst: Any,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        self._move(src, dst, src_dir_fd, dst_dir_fd, replace=False)

    def replace(
        self,
        src: Any,
        dst: Any,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        self._move(src, dst, src_dir_fd, dst_dir_fd, replace=True)

    def _move(
        self,
        src: Any,
        dst: Any,
        src_dir_fd: int | None,
        dst_dir_fd: int | None,
        replace: bool,
    ) -> None:
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
            move = self._host.replace if replace else self._host.rename
            move(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
            return
        if source is None or dest is None:
            raise OSError(
                posix_errno(FsCondition.EXDEV),
                posix_phrase(FsCondition.EXDEV),
                _spelled(src),
                None,
                _spelled(dst),
            )
        # Both ends as the walk names them before the rename, which may
        # move a link the walk takes. A rename onto its own name changes
        # nothing, its descriptors included.
        old = self._descriptors.walked(source, False)
        new = self._descriptors.walked(dest, False)
        held = [] if old == new else self._descriptors.hold(dest)
        self._adapter.rename(source, dest)
        self._descriptors.keep(held)
        self._descriptors.moved(old, new)

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
            if parent and self._adapter.stat_or_none(parent) is None:
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

    def symlink(
        self,
        src: Any,
        dst: Any,
        target_is_directory: bool = False,
        *,
        dir_fd: int | None = None,
    ) -> None:
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
        self._adapter.symlink(virtual, _real_os.fsdecode(src))

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
        return self._adapter.readlink(virtual)

    def truncate(self, path: Any, length: int) -> None:
        if self._descriptors.get(path) is not None:
            self.ftruncate(path, length)
            return
        virtual = self._virtual(path)
        if virtual is None:
            self._host.truncate(path, length)
            return
        # truncate(2) names a file that is there; the op creates a
        # missing one, as GNU truncate does without -c.
        self._adapter.stat(virtual)
        self._descriptors.land_path(virtual)
        self._adapter.truncate(virtual, length)

    def open(
        self,
        path: Any,
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        """Open a path by open(2) flags; a mounted one gets a descriptor
        of this router's, which the descriptor calls answer for. ``mode``
        is dropped on a mount, as for mkdir.

        Args:
            path (Any): the path to open.
            flags (int): the ``os.O_*`` flags.
            mode (int): permission bits for a create.
            dir_fd (int | None): honored only off a mount.
        """
        virtual = self._virtual(path)
        if virtual is None:
            return cast(int, self._host.open(path, flags, mode, dir_fd=dir_fd))
        return self._descriptors.open(virtual, flags)

    def close(self, fd: int) -> None:
        self._descriptors.close(fd)

    def read(self, fd: int, n: int) -> bytes:
        if n < 0:
            raise fs_error(self._descriptors[fd].path, FsCondition.EINVAL)
        return self._descriptors.file(fd, True, False).read(n)

    def write(self, fd: int, data: Any) -> int:
        payload = bytes(data)
        self._descriptors.file(fd, False, True).write(payload)
        return len(payload)

    def pread(self, fd: int, n: int, offset: int) -> bytes:
        handle = self._descriptors.file(fd, True, False)
        if offset < 0 or n < 0:
            raise fs_error(self._descriptors[fd].path, FsCondition.EINVAL)
        return handle.pread(offset, n)

    def pwrite(self, fd: int, data: Any, offset: int) -> int:
        payload = bytes(data)
        handle = self._descriptors.file(fd, False, True)
        if offset < 0:
            raise fs_error(self._descriptors[fd].path, FsCondition.EINVAL)
        # Linux appends a positioned write on an O_APPEND descriptor,
        # whatever the offset, and leaves the position where it was.
        handle.pwrite(handle.size if handle.append else offset, payload)
        return len(payload)

    def readv(self, fd: int, buffers: Any) -> int:
        views = _views(buffers)
        return _scatter(self.read(fd, sum(map(len, views))), views)

    def preadv(
        self, fd: int, buffers: Any, offset: int, flags: int = 0
    ) -> int:
        """Read into ``buffers`` at ``offset``; -1 reads at the
        descriptor's position and moves it, as Linux's preadv does.

        Args:
            fd (int): the descriptor.
            buffers (Any): the writable buffers to fill, in order.
            offset (int): where the read starts, or -1.
            flags (int): the ``RWF_*`` flags, none of which a mount
                answers, so any refuses rather than being dropped.
        """
        self._no_flags(fd, flags)
        views = _views(buffers)
        size = sum(map(len, views))
        if offset == -1:
            return _scatter(self.read(fd, size), views)
        return _scatter(self.pread(fd, size, offset), views)

    def writev(self, fd: int, buffers: Any) -> int:
        return self.write(fd, b"".join(map(bytes, buffers)))

    def pwritev(
        self, fd: int, buffers: Any, offset: int, flags: int = 0
    ) -> int:
        """Write ``buffers`` at ``offset``; -1 writes at the descriptor's
        position and moves it, as Linux's pwritev does.

        Args:
            fd (int): the descriptor.
            buffers (Any): the buffers to write, in order.
            offset (int): where the write starts, or -1.
            flags (int): the ``RWF_*`` flags, none of which a mount
                answers (``RWF_APPEND`` included), so any refuses rather
                than being dropped.
        """
        self._no_flags(fd, flags)
        payload = b"".join(map(bytes, buffers))
        if offset == -1:
            return self.write(fd, payload)
        return self.pwrite(fd, payload, offset)

    def _no_flags(self, fd: int, flags: int) -> None:
        """Refuse a vectored call's flags, ENOTSUP as Linux answers one it
        does not support.

        Args:
            fd (int): the descriptor.
            flags (int): the ``RWF_*`` flags.
        """
        if flags:
            raise fs_error(self._descriptors[fd].path, FsCondition.ENOTSUP)

    def lseek(self, fd: int, pos: int, how: int) -> int:
        desc = self._descriptors[fd]
        if desc.handle is None:
            return 0
        moved = desc.handle.seek(pos, how)
        if moved is None:
            raise fs_error(desc.path, FsCondition.EINVAL)
        return moved

    def fstat(self, fd: int) -> _real_os.stat_result:
        desc = self._descriptors[fd]
        st = (
            desc.stat
            if desc.kept is not None and desc.stat is not None
            else self._adapter.stat(desc.path)
        )
        if desc.handle is not None:
            st = dataclasses.replace(st, size=desc.handle.size)
        return self._stat_of(desc.opened, st, desc.kept is not None)

    def fsync(self, fd: int) -> None:
        self._descriptors.land(self._descriptors[fd])

    def ftruncate(self, fd: int, length: int) -> None:
        if not self._descriptors[fd].facts.writable:
            raise fs_error(self._descriptors[fd].path, FsCondition.EINVAL)
        self._descriptors.file(fd, False, True).truncate(length)

    # A descriptor in a path slot names its file, so these are the path
    # calls; a mount keeps no metadata apart from the data a sync lands.
    fchmod = chmod
    fchown = chown
    fdatasync = fsync

    def fdopen(self, fd: int, *args: Any, **kwargs: Any) -> Any:
        """A file object over a mounted descriptor, whose reads and writes
        go through the handle its ``open`` made.

        Args:
            fd (int): the descriptor.
            *args (Any): the rest of ``io.open``'s arguments.
            **kwargs (Any): the same, by name.
        """
        return self._descriptors.stream(fd, *args, **kwargs)


# The path argument each ``*dir_fd`` keyword anchors, by position.
_ANCHORS: tuple[tuple[str, int], ...] = (
    ("dir_fd", 0),
    ("src_dir_fd", 0),
    ("dst_dir_fd", 1),
)


def _anchored(router: HostFs, verb: str) -> Callable[..., Any]:
    """`verb` through the entry point, a relative path under a mounted
    directory descriptor first resolved against it, as openat(2) does.

    Args:
        router (HostFs): the entry point.
        verb (str): the os name being wrapped.
    """
    call = syscall(getattr(router, verb))

    def anchored(*args: Any, **kwargs: Any) -> Any:
        given = list(args)
        for key, index in _ANCHORS:
            # A symlink's dir_fd anchors the link it makes, not its target.
            at = 1 if verb == "symlink" and key == "dir_fd" else index
            desc = router.descriptors.get(kwargs.get(key))
            spelled = _spelled(given[at]) if at < len(given) else None
            if desc is None or spelled is None or posixpath.isabs(spelled):
                continue
            # An empty name is no entry in the directory, not the
            # directory itself.
            if not spelled:
                raise FileNotFoundError(
                    errno.ENOENT, _real_os.strerror(errno.ENOENT), spelled
                )
            # Joined as spelled: the dispatch resolves the dots, and its
            # walk refuses a missing directory before a `..`, as the
            # kernel's does.
            given[at] = posixpath.join(desc.path, spelled)
            del kwargs[key]
        return call(*given, **kwargs)

    return anchored


def _views(buffers: Any) -> list[memoryview]:
    """The byte views of the buffers a vectored read fills.

    Args:
        buffers (Any): the caller's writable buffers.
    """
    return [memoryview(buffer).cast("B") for buffer in buffers]


def _scatter(data: bytes, views: list[memoryview]) -> int:
    """Copy ``data`` across ``views`` in order, as readv(2) fills them.

    Args:
        data (bytes): what the read returned.
        views (list[memoryview]): the buffers to fill.
    """
    at = 0
    for view in views:
        chunk = data[at : at + len(view)]
        view[: len(chunk)] = chunk
        at += len(chunk)
    return at


def _descriptor_refusal(
    router: HostFs, verb: str, params: tuple[str, ...]
) -> Callable[..., Any]:
    """`verb` refusing ENOTSUP when a descriptor it takes, by position or
    by name, is one the routed ``open`` handed out, and the host's
    otherwise.

    Args:
        router (HostFs): the entry point whose descriptors refuse.
        verb (str): the os name being wrapped.
        params (tuple[str, ...]): the names of its descriptor
            parameters, in order, which lead its signature.
    """
    real = getattr(router._host, verb)

    def refuse(*args: Any, **kwargs: Any) -> Any:
        for at, param in enumerate(params):
            fd = args[at] if at < len(args) else kwargs.get(param)
            desc = router.descriptors.get(fd)
            if desc is not None:
                raise fs_error(desc.path, FsCondition.ENOTSUP)
        return real(*args, **kwargs)

    return refuse


def _by_descriptor(router: HostFs, verb: str) -> Callable[..., Any]:
    """`verb` answering for a descriptor the routed ``open`` handed out,
    and leaving every other number to the host.

    Args:
        router (HostFs): the entry point whose descriptors answer.
        verb (str): the os name being wrapped.
    """
    mounted = syscall(getattr(router, verb))
    real = getattr(router._host, verb)

    def call(fd: Any, *args: Any, **kwargs: Any) -> Any:
        if router.descriptors.get(fd) is None:
            return real(fd, *args, **kwargs)
        return mounted(fd, *args, **kwargs)

    return call


def _refusal(
    router: HostFs, verb: str, condition: FsCondition
) -> Callable[..., Any]:
    """A wrapper that refuses `verb` on a mount and passes it through off one.

    Every argument is scanned rather than just the first, because
    the refused verbs put their paths in different slots (``link`` has
    two ends and ``listxattr`` has an optional one) and a non-path
    argument answers None on its own.

    Args:
        router (HostFs): the entry point, for its mount test.
        verb (str): the os name being wrapped.
        condition (FsCondition): what the table says to answer.
    """
    real = getattr(router._host, verb)

    def refuse(*args: Any, **kwargs: Any) -> Any:
        for value in (*args, *kwargs.values()):
            virtual = router._virtual(value)
            if virtual is not None:
                raise fs_error(virtual, condition)
        return real(*args, **kwargs)

    return refuse


def _rebind(
    module: types.ModuleType, replacements: dict[str, Any]
) -> types.ModuleType:
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
        if (
            not isinstance(value, types.FunctionType)
            or value.__globals__ is not module.__dict__
        ):
            continue
        rebound = types.FunctionType(
            value.__code__,
            copy.__dict__,
            name,
            value.__defaults__,
            value.__closure__,
        )
        rebound.__kwdefaults__ = value.__kwdefaults__
        copy.__dict__[name] = rebound
    return copy


def os_routing(router: HostFs) -> dict[str, Callable[..., Any]]:
    """Every `os` name that must not answer from the host, and what does.

    Built from the tables in ``host/constants``: a routed name gets
    the workspace entry point, a refused name gets that table's errno on a
    mounted path, and every other name is absent here, which the coverage
    test keeps to names that take a program or a string, never a file. A
    name the host python does not have (``lchmod`` off macOS) is absent
    too, so ``hasattr`` still reports what it did before.

    The table is what makes the fix complete rather than a list someone
    maintains: ``os.walk`` reads ``os.scandir`` and ``os.path.exists``
    reads ``os.stat``, so one name left pointing at the host takes a
    whole family with it, which is how ten patched names left the rest
    of the module answering about paths it has never had.

    The descriptor calls answer for the numbers the routed ``open``
    hands out, or refuse them where a mount has nothing to answer with,
    and pass every other number to the host.

    Args:
        router (HostFs): the entry point the names answer through, whose
            descriptors ``open`` shares.

    Returns:
        dict[str, Callable[..., Any]]: os name to replacement function.
    """
    table: dict[str, Callable[..., Any]] = {}
    for verb in ROUTED_CALLS:
        if hasattr(_real_os, verb):
            table[verb] = _anchored(router, verb)
    for verb in DESCRIPTOR_CALLS:
        if hasattr(_real_os, verb):
            table[verb] = _by_descriptor(router, verb)
    for verb, condition in REFUSED_CALLS.items():
        if hasattr(_real_os, verb):
            table[verb] = syscall(_refusal(router, verb, condition))
    for verb, params in REFUSED_DESCRIPTOR_CALLS.items():
        if hasattr(_real_os, verb):
            table[verb] = syscall(_descriptor_refusal(router, verb, params))
    return table


def make_os_module(
    files: Files, loop: asyncio.AbstractEventLoop | None = None
) -> types.ModuleType:
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
        files (Files): The facade with the mount table.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.

    Returns:
        types.ModuleType: A patched os module.
    """
    patched = types.ModuleType("os")
    patched.__dict__.update(_real_os.__dict__)
    patched.__dict__.update(os_routing(HostFs(files, loop)))
    generic = _rebind(genericpath, {"os": patched})
    shared = {name: generic.__dict__[name] for name in genericpath.__all__}
    patched.__dict__["path"] = _rebind(posixpath, {"os": patched, **shared})
    return patched
