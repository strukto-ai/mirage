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
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass
from typing import Any, TypeVar
from weakref import WeakKeyDictionary

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

from mirage.errors.fs import eexist, eisdir, enoent
from mirage.errors.types import NoMountError
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.mount.types import MountAttrs
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.constants import LISTING_CONCURRENCY
from mirage.server.ssh.session import (
    key_profile,
    login_entry,
    new_session_id,
    open_session,
)
from mirage.server.ssh.stream import ENCODING, ERRORS

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


def to_attrs(st: MountAttrs) -> asyncssh.SFTPAttrs:
    """SFTP attributes from what the mount core answered.

    Args:
        st (MountAttrs): what ``MountCore.getattr`` returned.

    Returns:
        asyncssh.SFTPAttrs: the same facts in SFTP's shape.
    """
    atime, atime_ns = divmod(st.atime, NS_PER_SECOND)
    mtime, mtime_ns = divmod(st.mtime, NS_PER_SECOND)
    return asyncssh.SFTPAttrs(
        type=filetype(st.mode),
        size=st.size,
        uid=st.uid,
        gid=st.gid,
        permissions=st.mode,
        atime=atime,
        atime_ns=atime_ns,
        mtime=mtime,
        mtime_ns=mtime_ns,
        nlink=st.nlink,
    )


async def exists(core: MountCore, path: str) -> bool:
    try:
        await core.getattr(path)
    except (FileNotFoundError, NotADirectoryError, NoMountError):
        return False
    return True


# One cap per workspace loop, so channels that list at once on one
# workspace share it rather than each bringing a cap of its own.
_STATS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    WeakKeyDictionary()
)


async def listing(core: MountCore, path: str) -> list[tuple[str, MountAttrs]]:
    """A directory's entries with their attributes, in one pass.

    The entries are stat'd together rather than one after another, by at
    most ``LISTING_CONCURRENCY`` workers, with at most that many stats out
    at once across every listing on the workspace's loop. A stat that
    fails ends the listing and cancels the ones still waiting. An entry
    that vanishes between the listing and its stat is left out, as ``ls``
    leaves out a file deleted mid-listing.

    Args:
        core (MountCore): the mount core.
        path (str): the directory.

    Returns:
        list[tuple[str, MountAttrs]]: (name, attributes) pairs,
            ``.`` and ``..`` first.
    """
    loop = asyncio.get_running_loop()
    slots = _STATS.get(loop)
    if slots is None:
        slots = _STATS[loop] = asyncio.Semaphore(LISTING_CONCURRENCY)

    async def entry(name: str) -> tuple[str, MountAttrs] | None:
        if name == ".":
            child = path
        elif name == "..":
            child = posixpath.dirname(path)
        else:
            child = posixpath.join(path, name)
        async with slots:
            try:
                return name, await core.getattr(child)
            except (FileNotFoundError, NotADirectoryError) as exc:
                logger.debug("sftp: %s vanished while listing: %r", child, exc)
                return None

    names = await core.readdir(path)
    rows: list[tuple[str, MountAttrs] | None] = [None] * len(names)
    todo = iter(enumerate(names))

    async def worker() -> None:
        for index, name in todo:
            rows[index] = await entry(name)

    try:
        async with asyncio.TaskGroup() as group:
            for _ in range(min(LISTING_CONCURRENCY, len(names))):
                group.create_task(worker())
    except BaseExceptionGroup as failed:
        # The first refusal is the listing's answer, as it was before the
        # rest were cancelled.
        raise failed.exceptions[0]
    return [row for row in rows if row is not None]


async def open_file(
    core: MountCore, path: str, pflags: int, mode: int | None = None
) -> OpenFile:
    """Open or create a file the way an SFTP ``open`` asks.

    Args:
        core (MountCore): the mount core.
        path (str): the file.
        pflags (int): SFTP v3 open flags.
        mode (int | None): the permissions a create asks for.

    Returns:
        OpenFile: the new handle.

    Raises:
        FileExistsError: CREAT|EXCL on an existing path.
        FileNotFoundError: no such file and no CREAT.
        IsADirectoryError: the path is a directory.
    """
    found = await exists(core, path)
    if found and pflags & FXF_CREAT and pflags & FXF_EXCL:
        raise eexist(path)
    if not found:
        if not pflags & FXF_CREAT:
            raise enoent(path)
        fh = await core.create(path, mode)
    else:
        if stat.S_ISDIR((await core.getattr(path)).mode):
            raise eisdir(path)
        fh = await core.open(path, os.O_TRUNC if pflags & FXF_TRUNC else 0)
    append_at = None
    if pflags & FXF_APPEND:
        append_at = (await core.fgetattr(path, fh)).size
    return OpenFile(path, fh, append_at)


def epoch_ns(seconds: int | None, ns: int | None) -> int | None:
    """An SFTP time (whole seconds plus a nanosecond part) in epoch ns.

    Args:
        seconds (int | None): the whole seconds, None when not sent.
        ns (int | None): the nanosecond part, when sent.
    """
    return None if seconds is None else seconds * NS_PER_SECOND + (ns or 0)


async def set_attrs(
    core: MountCore, path: str, attrs: asyncssh.SFTPAttrs, follow: bool
) -> None:
    """Apply an SFTP setstat: a size truncates, and permissions, owner
    and times are stored as chmod, chown and utimens through a kernel
    mount store them. One with nothing to change still needs the path.

    Args:
        core (MountCore): the mount core.
        path (str): the path.
        attrs (asyncssh.SFTPAttrs): what the client asked to change.
        follow (bool): change a trailing link's target (setstat,
            fsetstat), or the link itself (lsetstat).
    """
    if attrs.size is not None:
        await core.truncate(path, attrs.size)
    fields = (
        attrs.permissions,
        attrs.uid,
        attrs.gid,
        epoch_ns(attrs.atime, attrs.atime_ns),
        epoch_ns(attrs.mtime, attrs.mtime_ns),
    )
    if any(field is not None for field in fields):
        await core.setattr(path, *fields, follow=follow)
    elif attrs.size is None:
        await core.getattr(path, follow=follow)


async def rename_new(core: MountCore, old: str, new: str) -> None:
    """SFTP v3 rename, which refuses to replace an existing target.

    Args:
        core (MountCore): the mount core.
        old (str): the current path.
        new (str): the new path.
    """
    if await exists(core, new):
        raise eexist(new)
    await core.rename(old, new)


async def vfs_attrs(core: MountCore) -> asyncssh.SFTPVFSAttrs:
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
    and policies a shell in that session sees. Requests run one at a
    time, in the order they arrive, on the workspace's own loop.

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

    async def _mount(self) -> tuple[WorkspaceEntry, MountCore]:
        if self._entry is not None and self._core is not None:
            return self._entry, self._core
        entry = login_entry(self._registry, self._conn, self._workspace_id)
        if entry is None:
            raise asyncssh.SFTPNoSuchFile(
                f"no such workspace: {self._workspace_id}"
            )
        ws = entry.runner.ws
        profile = key_profile(self._conn)
        await entry.runner.call(
            open_session(ws, self._session_id, profile=profile)
        )
        self._entry = entry
        self._core = MountCore(
            ws.vfs, session=ws.get_session(self._session_id)
        )
        return entry, self._core

    async def _call(
        self, op: Callable[[MountCore], Coroutine[Any, Any, T]]
    ) -> T:
        async with self._lock:
            entry, core = await self._mount()
            try:
                return await entry.runner.call(op(core))
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
            await self._call(lambda core: core.getattr(p, follow=True))
        )

    async def lstat(self, path: bytes) -> asyncssh.SFTPAttrs:
        p = self._path(path)
        return to_attrs(await self._call(lambda core: core.getattr(p)))

    async def fstat(self, file_obj: Any) -> asyncssh.SFTPAttrs:
        f = opened(file_obj)
        return to_attrs(
            await self._call(lambda core: core.fgetattr(f.path, f.fh))
        )

    async def setstat(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        p = self._path(path)
        await self._call(lambda core: set_attrs(core, p, attrs, True))

    async def lsetstat(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        p = self._path(path)
        await self._call(lambda core: set_attrs(core, p, attrs, False))

    async def fsetstat(self, file_obj: Any, attrs: asyncssh.SFTPAttrs) -> None:
        f = opened(file_obj)

        async def resize(core: MountCore) -> None:
            ctx = core.handles.get(f.fh)
            if ctx is None:
                raise asyncssh.SFTPFailure("invalid handle")
            if ctx.detached:
                # Its name now belongs to another file, or to none.
                raise enoent(ctx.path)
            await set_attrs(core, ctx.path, attrs, True)

        await self._call(resize)

    async def scandir(self, path: bytes) -> AsyncIterator[asyncssh.SFTPName]:
        p = self._path(path)
        for name, st in await self._call(lambda core: listing(core, p)):
            yield asyncssh.SFTPName(self._encode(name), attrs=to_attrs(st))

    async def open(
        self, path: bytes, pflags: int, attrs: asyncssh.SFTPAttrs
    ) -> OpenFile:
        p = self._path(path)
        return await self._call(
            lambda core: open_file(core, p, pflags, attrs.permissions)
        )

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
        await self._call(lambda core: core.mkdir(p, attrs.permissions))

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
