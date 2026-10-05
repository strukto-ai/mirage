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
import logging
import os
import posixpath
import stat
from collections import deque
from collections.abc import AsyncIterator, Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from functools import partial
from typing import Any, TypeVar

import asyncssh
from asyncssh.constants import (
    FILEXFER_TYPE_DIRECTORY,
    FILEXFER_TYPE_REGULAR,
    FILEXFER_TYPE_SYMLINK,
    FILEXFER_TYPE_UNKNOWN,
    FXF_APPEND,
    FXF_CREAT,
    FXF_EXCL,
    FXF_TRUNC,
)

from mirage.fuse.core import MountCore
from mirage.fuse.errors import classify_error
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.constants import LISTING_CONCURRENCY
from mirage.server.ssh.session import key_profile, new_session_id, open_session
from mirage.server.ssh.stream import ENCODING, ERRORS
from mirage.utils.errors import NoMountError

logger = logging.getLogger(__name__)

T = TypeVar("T")

NS_PER_SECOND = 1_000_000_000


@dataclass(slots=True)
class OpenFile:
    """An SFTP file handle: the MountCore handle behind it.

    Args:
        path (str): the workspace path it was opened on.
        fh (int): the MountCore handle id.
        append_at (int | None): where the next write lands when the file
            was opened for append, None otherwise.
    """

    path: str
    fh: int
    append_at: int | None = None


def opened(file_obj: Any) -> OpenFile:
    """Validate the opaque handle asyncssh passes to a file callback.

    ``Any`` at the library boundary keeps the overrides compatible with
    asyncssh. Only a validated ``OpenFile`` reaches the mount operations.

    Args:
        file_obj (Any): what asyncssh passed back.

    Returns:
        OpenFile: the handle.

    Raises:
        asyncssh.SFTPFailure: the value is not a handle this server made.
    """
    if not isinstance(file_obj, OpenFile):
        raise asyncssh.SFTPFailure("invalid handle")
    return file_obj


def filetype(mode: int) -> int:
    if stat.S_ISDIR(mode):
        return FILEXFER_TYPE_DIRECTORY
    if stat.S_ISLNK(mode):
        return FILEXFER_TYPE_SYMLINK
    if stat.S_ISREG(mode):
        return FILEXFER_TYPE_REGULAR
    return FILEXFER_TYPE_UNKNOWN


def to_attrs(st: dict[str, Any]) -> asyncssh.SFTPAttrs:
    """SFTP attributes from a MountCore ``st_*`` dict (times in ns).

    Args:
        st (dict[str, Any]): what ``MountCore.getattr`` returned.

    Returns:
        asyncssh.SFTPAttrs: the same facts in SFTP's shape.
    """
    mode = st["st_mode"]
    atime, atime_ns = divmod(st["st_atime"], NS_PER_SECOND)
    mtime, mtime_ns = divmod(st["st_mtime"], NS_PER_SECOND)
    return asyncssh.SFTPAttrs(
        type=filetype(mode),
        size=st["st_size"],
        uid=st["st_uid"],
        gid=st["st_gid"],
        permissions=mode,
        atime=atime,
        atime_ns=atime_ns,
        mtime=mtime,
        mtime_ns=mtime_ns,
        nlink=st["st_nlink"],
    )


def exists(core: MountCore, path: str) -> bool:
    try:
        core.getattr(path)
    except (FileNotFoundError, NotADirectoryError, NoMountError):
        return False
    return True


# One pool for every listing in the process, so channels that list at
# once share its threads rather than each bringing a pool of its own.
_STATS = ThreadPoolExecutor(
    LISTING_CONCURRENCY, thread_name_prefix="sftp-stat"
)


def listing(core: MountCore, path: str) -> list[tuple[str, dict[str, Any]]]:
    """A directory's entries with their attributes, in one pass.

    The entries are stat'd together on the shared pool rather than one
    after another, with at most ``LISTING_CONCURRENCY`` of this listing's
    queued at once, so a wide directory is never queued whole. A stat that
    fails ends the listing once the ones already running finish: the core
    takes one caller at a time, so the next op must not overlap them. An
    entry that vanishes between the listing and its stat is left out, as
    ``ls`` leaves out a file deleted mid-listing.

    Args:
        core (MountCore): the mount core.
        path (str): the directory.

    Returns:
        list[tuple[str, dict[str, Any]]]: (name, ``st_*`` dict) pairs,
            ``.`` and ``..`` first.
    """
    stat = partial(_entry, core, path)
    window: deque[Future[tuple[str, dict[str, Any]] | None]] = deque()
    rows = []
    try:
        for name in core.readdir(path):
            if len(window) == LISTING_CONCURRENCY:
                rows.append(window.popleft().result())
            window.append(_STATS.submit(stat, name))
        while window:
            rows.append(window.popleft().result())
    finally:
        wait(window)
    return [row for row in rows if row is not None]


def _entry(
    core: MountCore, path: str, name: str
) -> tuple[str, dict[str, Any]] | None:
    if name == ".":
        child = path
    elif name == "..":
        child = posixpath.dirname(path)
    else:
        child = posixpath.join(path, name)
    try:
        return name, core.getattr(child)
    except (FileNotFoundError, NotADirectoryError) as exc:
        logger.debug("sftp: %s vanished while listing: %r", child, exc)
        return None


def open_file(core: MountCore, path: str, pflags: int) -> OpenFile:
    """Open or create a file the way an SFTP ``open`` asks.

    Args:
        core (MountCore): the mount core.
        path (str): the file.
        pflags (int): SFTP v3 open flags.

    Returns:
        OpenFile: the new handle.

    Raises:
        FileExistsError: CREAT|EXCL on an existing path.
        FileNotFoundError: no such file and no CREAT.
        IsADirectoryError: the path is a directory.
    """
    found = exists(core, path)
    if found and pflags & FXF_CREAT and pflags & FXF_EXCL:
        raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), path)
    if not found:
        if not pflags & FXF_CREAT:
            raise FileNotFoundError(
                errno.ENOENT, os.strerror(errno.ENOENT), path
            )
        fh = core.create(path)
    else:
        if stat.S_ISDIR(core.getattr(path)["st_mode"]):
            raise IsADirectoryError(
                errno.EISDIR, os.strerror(errno.EISDIR), path
            )
        fh = core.open(path, os.O_TRUNC if pflags & FXF_TRUNC else 0)
    append_at = None
    if pflags & FXF_APPEND:
        append_at = core.getattr(path, fh)["st_size"]
    return OpenFile(path, fh, append_at)


def set_size(core: MountCore, path: str, size: int | None) -> None:
    """Apply an SFTP setstat: a size truncates, anything else is accepted
    once the path is known to exist, as the FUSE adapter treats chmod,
    chown and utimens.

    Args:
        core (MountCore): the mount core.
        path (str): the path.
        size (int | None): the requested size, if any.
    """
    if size is not None:
        core.truncate(path, size)
    else:
        core.getattr(path)


def rename_new(core: MountCore, old: str, new: str) -> None:
    """SFTP v3 rename, which refuses to replace an existing target.

    Args:
        core (MountCore): the mount core.
        old (str): the current path.
        new (str): the new path.
    """
    if exists(core, new):
        raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), new)
    core.rename(old, new)


def vfs_attrs(core: MountCore) -> asyncssh.SFTPVFSAttrs:
    st = core.statfs()
    return asyncssh.SFTPVFSAttrs(
        bsize=st["f_bsize"],
        frsize=st["f_frsize"],
        blocks=st["f_blocks"],
        bfree=st["f_bfree"],
        bavail=st["f_bavail"],
        files=st["f_files"],
        ffree=st["f_ffree"],
        favail=st["f_favail"],
        fsid=0,
        flag=0,
        namemax=st["f_namemax"],
    )


def as_os_error(err: Exception) -> OSError:
    """The errno asyncssh turns into an SFTP status, from the shared table.

    Args:
        err (Exception): what the core raised.

    Returns:
        OSError: carrying the classified errno.
    """
    code = classify_error(err)
    if code == errno.EIO and not isinstance(err, (OSError, ValueError)):
        logger.warning("sftp: unclassified error: %r", err)
    if code in (errno.EROFS, errno.EPERM):
        # SFTP v3 says permission denied for every refused write; asyncssh
        # would send EROFS as write-protect, which a v3 client cannot read.
        return OSError(errno.EACCES, os.strerror(code))
    return OSError(code, os.strerror(code))


class MirageSFTPServer(asyncssh.SFTPServer):
    """SFTP (and scp) onto a workspace, through the MountCore FUSE uses.

    Every request lands on one MountCore bound to a session of its own,
    under the login key's profile, so SFTP sees exactly the tree, modes
    and policies a shell in that session sees. The core is synchronous
    (FUSE calls it from a single thread), so calls run one at a time in a
    worker thread, and the core runs each op on the workspace's own loop.

    asyncssh's base class serves the host's real filesystem from every
    method a subclass leaves alone, so this class overrides all of them
    and ``map_path`` refuses, keeping a future asyncssh method from
    reaching the host.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces; the SSH
            username names the one served.
        chan (asyncssh.SSHServerChannel): the SFTP channel.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        chan: asyncssh.SSHServerChannel[bytes],
    ) -> None:
        super().__init__(chan)
        self._registry = registry
        self._workspace_id: str = chan.get_extra_info("username")
        self._conn = chan.get_connection()
        self._session_id = new_session_id()
        self._entry: WorkspaceEntry | None = None
        self._core: MountCore | None = None
        self._lock = asyncio.Lock()

    async def _mount(self) -> MountCore:
        if self._core is not None:
            return self._core
        if self._workspace_id not in self._registry:
            raise asyncssh.SFTPNoSuchFile(
                f"no such workspace: {self._workspace_id}"
            )
        entry = self._registry.get(self._workspace_id)
        ws = entry.runner.ws
        profile = key_profile(self._conn)
        await entry.runner.call(
            open_session(ws, self._session_id, profile=profile)
        )
        self._entry = entry
        self._core = MountCore(
            ws.vfs,
            session=ws.get_session(self._session_id),
            loop=entry.runner.loop,
        )
        return self._core

    async def _call(self, op: Callable[[MountCore], T]) -> T:
        async with self._lock:
            core = await self._mount()
            try:
                return await asyncio.to_thread(op, core)
            except Exception as err:
                raise as_os_error(err) from err

    def _path(self, path: bytes) -> str:
        text = path.decode(ENCODING, ERRORS)
        return posixpath.normpath("/" + text.lstrip("/"))

    def _encode(self, path: str) -> bytes:
        return path.encode(ENCODING, ERRORS)

    def map_path(self, path: bytes) -> bytes:
        raise asyncssh.SFTPOpUnsupported("host paths are not served")

    def reverse_map_path(self, path: bytes) -> bytes:
        raise asyncssh.SFTPOpUnsupported("host paths are not served")

    async def realpath(self, path: bytes) -> bytes:
        return self._encode(self._path(path))

    async def stat(self, path: bytes) -> asyncssh.SFTPAttrs:
        p = self._path(path)
        return to_attrs(
            await self._call(lambda core: core.getattr(core.identity(p)))
        )

    async def lstat(self, path: bytes) -> asyncssh.SFTPAttrs:
        p = self._path(path)
        return to_attrs(await self._call(lambda core: core.getattr(p)))

    async def fstat(self, file_obj: Any) -> asyncssh.SFTPAttrs:
        f = opened(file_obj)
        return to_attrs(
            await self._call(lambda core: core.getattr(f.path, f.fh))
        )

    async def setstat(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        p = self._path(path)
        await self._call(lambda core: set_size(core, p, attrs.size))

    async def lsetstat(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        await self.setstat(path, attrs)

    async def fsetstat(self, file_obj: Any, attrs: asyncssh.SFTPAttrs) -> None:
        f = opened(file_obj)

        def resize(core: MountCore) -> None:
            ctx = core.handles.get(f.fh)
            if ctx is None:
                raise asyncssh.SFTPFailure("invalid handle")
            set_size(core, ctx.path, attrs.size)

        await self._call(resize)

    async def scandir(self, path: bytes) -> AsyncIterator[asyncssh.SFTPName]:
        p = self._path(path)
        for name, st in await self._call(lambda core: listing(core, p)):
            yield asyncssh.SFTPName(self._encode(name), attrs=to_attrs(st))

    async def open(
        self, path: bytes, pflags: int, attrs: asyncssh.SFTPAttrs
    ) -> OpenFile:
        p = self._path(path)
        return await self._call(lambda core: open_file(core, p, pflags))

    async def open56(
        self,
        path: bytes,
        desired_access: int,
        flags: int,
        attrs: asyncssh.SFTPAttrs,
    ) -> OpenFile:
        raise asyncssh.SFTPOpUnsupported("SFTP v5+ open is not supported")

    async def read(self, file_obj: Any, offset: int, size: int) -> bytes:
        f = opened(file_obj)
        return await self._call(
            lambda core: core.read(f.path, size, offset, f.fh)
        )

    async def write(self, file_obj: Any, offset: int, data: bytes) -> int:
        f = opened(file_obj)
        if f.append_at is not None:
            offset = f.append_at
            f.append_at += len(data)
        return await self._call(
            lambda core: core.write(f.path, data, offset, f.fh)
        )

    async def fsync(self, file_obj: Any) -> None:
        f = opened(file_obj)
        await self._call(lambda core: core.flush(f.path, f.fh))

    async def close(self, file_obj: Any) -> None:
        f = opened(file_obj)
        await self._call(lambda core: core.release(f.fh))

    async def remove(self, path: bytes) -> None:
        p = self._path(path)
        await self._call(lambda core: core.unlink(p))

    async def mkdir(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        p = self._path(path)
        await self._call(lambda core: core.mkdir(p))

    async def rmdir(self, path: bytes) -> None:
        p = self._path(path)
        await self._call(lambda core: core.rmdir(p))

    async def rename(self, oldpath: bytes, newpath: bytes) -> None:
        old, new = self._path(oldpath), self._path(newpath)
        await self._call(lambda core: rename_new(core, old, new))

    async def posix_rename(self, oldpath: bytes, newpath: bytes) -> None:
        old, new = self._path(oldpath), self._path(newpath)
        await self._call(lambda core: core.rename(old, new))

    async def readlink(self, path: bytes) -> bytes:
        p = self._path(path)
        return self._encode(await self._call(lambda core: core.readlink(p)))

    async def symlink(self, oldpath: bytes, newpath: bytes) -> None:
        target = oldpath.decode(ENCODING, ERRORS)
        link = self._path(newpath)
        await self._call(lambda core: core.symlink(link, target))

    async def link(self, oldpath: bytes, newpath: bytes) -> None:
        raise asyncssh.SFTPOpUnsupported("hard links are not supported")

    async def lock(
        self, file_obj: Any, offset: int, length: int, flags: int
    ) -> None:
        raise asyncssh.SFTPOpUnsupported("byte-range locks are not supported")

    async def unlock(self, file_obj: Any, offset: int, length: int) -> None:
        raise asyncssh.SFTPOpUnsupported("byte-range locks are not supported")

    async def statvfs(self, path: bytes) -> asyncssh.SFTPVFSAttrs:
        return await self._call(vfs_attrs)

    async def fstatvfs(self, file_obj: Any) -> asyncssh.SFTPVFSAttrs:
        return await self._call(vfs_attrs)

    async def exit(self) -> None:
        entry = self._entry
        try:
            if (
                entry is not None
                and entry.id in self._registry
                and (self._registry.get(entry.id) is entry)
            ):
                await entry.runner.call(
                    entry.runner.ws.close_session(self._session_id)
                )
        finally:
            # asyncssh ends an SFTP channel with no exit status, which
            # OpenSSH's ssh reports as 255 and scp (in its default SFTP
            # mode) as a failed copy. sshd's internal-sftp reports 0, so
            # this does too; after scp's own handler has already exited
            # the channel, it is a no-op.
            self.channel.exit(0)
