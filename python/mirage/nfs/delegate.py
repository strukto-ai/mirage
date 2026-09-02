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
import os
import posixpath
import stat as stat_bits
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from mirage.mount.core import MountCore
from mirage.mount.types import MountAttrs, SetAttrs
from mirage.mount.writebuf import WriteBuffer
from mirage.nfs.config import NFSConfig
from mirage.nfs.errors import StaleHandleError
from mirage.nfs.ids import ROOT_PATH, IdTable
from mirage.nfs.types import DirEntry, NFSAttrs
from mirage.ops import Ops

# The core slices to the end when asked for more than the file holds,
# which is how a whole-file read is spelled through a sized API.
_WHOLE_FILE = 1 << 62


@dataclass(slots=True)
class _FlushLock:
    """One file's flush lock, with the count keeping it in the table.

    Args:
        lock (asyncio.Lock): serializes flushes of one file.
        waiters (int): callers holding or waiting for it. The table
            drops the entry at zero, so the map stays bounded by
            files being flushed rather than files ever written.
    """

    lock: asyncio.Lock
    waiters: int


def _component(name: str) -> str:
    """Refuse a name that is not a single path component.

    ``filename3`` is one component by definition, and nfsserve does not
    filter it, so the delegate is the only guard there is. A ``/`` here
    is a protocol violation; that it does not escape the mount today is
    luck -- nothing below this point normalizes ``..`` -- rather than a
    check. "." and ".." are refused for the mutating ops because
    neither names an entry to create or remove; ``lookup`` resolves
    them before calling this.

    Args:
        name (str): the name as it arrived on the wire.

    Returns:
        str: the same name, once it is known to be one component.

    Raises:
        OSError: EINVAL, the name is not a single component.
    """
    if name in ("", ".", "..") or "/" in name:
        raise OSError(errno.EINVAL, "not a single path component", name)
    return name


def _join(parent: str, name: str) -> str:
    return posixpath.join(parent,
                          name) if parent != ROOT_PATH else ROOT_PATH + name


class MirageNFS:
    """The NFSv3 filesystem the server crate calls back into.

    One method per trait callback, each one async so it runs on the
    workspace event loop and reaches the op door the same way a shell
    command does: mount grants, admission policies, cache and namespace
    all fire once, at that door. The adapter itself owns only what the
    protocol needs and mirage does not have -- which file id names which
    path, and the writes a client has sent but not yet had stored.

    Paths crossing this boundary are mount-relative; the mount prefix is
    applied by the op facade this is constructed with.
    """

    def __init__(self, ops: Ops, config: NFSConfig | None = None) -> None:
        self._ops = ops
        # The shared mount core. Every filesystem semantic the two
        # kernel tiers agree on -- link display, macOS metadata, entry
        # naming, stat shaping, the size-unknown rules -- is decided
        # there, so the adapters cannot drift. What stays here is what
        # NFSv3 alone needs: ids, the write buffer, the wire attrs.
        self._core = MountCore(ops)
        self._config = config or NFSConfig()
        self._ids = IdTable()
        self._writes = WriteBuffer()
        # One lock per file that has been written; dropped with the
        # buffer it guards, so the table tracks live files rather than
        # every id ever minted.
        self._flush_locks: dict[int, _FlushLock] = {}
        self._root = self._ids.alloc(ROOT_PATH)

    def root_dir(self) -> int:
        """The file id of the export root."""
        return self._root

    async def lookup(self, dirid: int, name: str) -> int:
        """Resolve a name inside a directory to a file id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the entry name.

        Returns:
            int: the entry's file id.

        Raises:
            StaleHandleError: the parent id is unknown.
            FileNotFoundError: no such entry.
        """
        parent = self._ids.resolve(dirid)
        # "." and ".." are the server's job over NFSv3: the kernel
        # resolves them above the filesystem for FUSE, which is why
        # MountCore never had to, and answering ENOENT for them here is
        # a cold-cache hole rather than a curiosity.
        if name == ".":
            return dirid
        if name == "..":
            if parent == ROOT_PATH:
                return dirid
            return self._ids.alloc(parent.rsplit("/", 1)[0] or ROOT_PATH)
        path = _join(parent, _component(name))
        # getattr refuses macOS metadata names and reports a link as a
        # link rather than following it, both of which this repeated.
        await self._core.getattr(path)
        return self._ids.alloc(path)

    async def getattr(self, fileid: int) -> NFSAttrs:
        """Attributes for a file id, counting writes not yet stored.

        Args:
            fileid (int): the file to stat.

        Returns:
            NFSAttrs: the shape the Rust layer converts to fattr3.
        """
        return await self._entry_attrs(fileid, self._ids.resolve(fileid))

    async def read(self, fileid: int, offset: int, count: int) -> bytes:
        """Read through any writes still buffered for this file.

        Args:
            fileid (int): the file to read.
            offset (int): where the read starts.
            count (int): how many bytes the client asked for.

        Returns:
            bytes: the slice, short at end of file.
        """
        path = self._ids.resolve(fileid)
        base = await self._read_base(path)
        return self._writes.overlay(fileid, base, offset, count)

    async def write(self, fileid: int, offset: int, data: bytes) -> NFSAttrs:
        """Buffer a write and answer with the size the client expects.

        The bytes are stored on flush, not here: this server answers
        every write as durable and never forwards a COMMIT, so the
        adapter batches and bounds the window itself.

        Args:
            fileid (int): the file being written.
            offset (int): byte offset the client wrote at.
            data (bytes): the payload.

        Returns:
            NFSAttrs: post-write attributes, with the extended size.
        """
        path = self._ids.resolve(fileid)
        full = self._writes.append(fileid,
                                   offset,
                                   data,
                                   max_bytes=self._config.max_buffered_bytes)
        if full:
            await self._flush_one(fileid, path)
        await self._drain_to_ceiling()
        return await self._entry_attrs(fileid, path)

    async def create(self, dirid: int, name: str) -> int:
        """Create an empty file and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the new file's name.

        Returns:
            int: the new file's id.
        """
        path = _join(self._ids.resolve(dirid), _component(name))
        fh = await self._core.create(path)
        # NFSv3 is handle-free; the core's handle would leak.
        await self._core.release(fh)
        return self._ids.alloc(path)

    async def create_exclusive(self, dirid: int, name: str) -> int:
        """Create a file, refusing a path that already holds one.

        NFSv3's EXCLUSIVE create is what ``O_CREAT|O_EXCL`` becomes on
        the wire, so it is every lockfile idiom there is -- pip, a git
        index.lock, any flock-style sentinel. Routed to the plain
        create, whose core truncates, "refuse to touch it" became
        "empty it", and the caller was told it had won the race.

        Mirage has no create-verifier to store and replay, so this
        implements the half of the semantics that carries the data
        loss: an existing path is refused, never opened.

        Args:
            dirid (int): the parent directory's id.
            name (str): the new file's name.

        Returns:
            int: the new file's id.

        Raises:
            FileExistsError: something already lives at that path.
        """
        path = _join(self._ids.resolve(dirid), _component(name))
        try:
            await self._core.attrs_for(path)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(errno.EEXIST, "File exists", path)
        return await self.create(dirid, name)

    async def mkdir(self, dirid: int, name: str) -> int:
        """Create a directory and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the new directory's name.

        Returns:
            int: the new directory's id.
        """
        path = _join(self._ids.resolve(dirid), _component(name))
        await self._core.mkdir(path)
        return self._ids.alloc(path)

    async def remove(self, dirid: int, name: str) -> None:
        """Remove a file or directory.

        The server routes both REMOVE and RMDIR here, so the entry is
        stat-ed first to pick the right op. Buffered writes are dropped
        rather than flushed: storing them would bring the file back.

        Args:
            dirid (int): the parent directory's id.
            name (str): the entry to remove.
        """
        path = _join(self._ids.resolve(dirid), _component(name))
        fileid = self._ids.id_for(path)
        if fileid is None:
            await self._remove_entry(path)
            return
        # Under the file's flush lock, and dropping only afterwards.
        # Dropping first lost acknowledged writes whenever the removal
        # then failed (a denied unlink, ENOTEMPTY on the rmdir arm):
        # the file survived, with its pre-write bytes. Doing it outside
        # the lock instead lets an idle flush land between the unlink
        # and the drop and recreate what was just removed.
        async with self._flush_lock(fileid):
            await self._remove_entry(path)
            self._writes.drop(fileid)
            self._ids.invalidate(fileid)
        self._flush_locks.pop(fileid, None)

    async def _remove_entry(self, path: str) -> None:
        """Remove one entry, picking the op from what it is.

        The core's unlink unlinks a link rather than following it, and
        its getattr reports a link as a link, which keeps one out of the
        rmdir arm and lets a broken one be removed at all.

        Args:
            path (str): the entry's mount path.
        """
        attrs = await self._core.attrs_for(path)
        if stat_bits.S_ISDIR(attrs.mode):
            await self._core.rmdir(path)
        else:
            await self._core.unlink(path)

    async def rename(self, from_dirid: int, from_name: str, to_dirid: int,
                     to_name: str) -> None:
        """Move an entry, carrying its id and pending writes with it.

        Pending writes are flushed to the old path first: they were
        acknowledged against it, and flushing after the move would merge
        them onto whatever now lives at the destination.

        Args:
            from_dirid (int): source directory id.
            from_name (str): source entry name.
            to_dirid (int): destination directory id.
            to_name (str): destination entry name.

        Raises:
            OSError: EINVAL when the destination lies inside the
                source, refused before the backend is touched.
        """
        src = _join(self._ids.resolve(from_dirid), _component(from_name))
        dst = _join(self._ids.resolve(to_dirid), _component(to_name))
        self._ids.guard_rename(src, dst)
        fileid = self._ids.id_for(src)
        if fileid is not None and self._writes.has_pending(fileid):
            await self._flush_one(fileid, src)
        await self._core.rename(src, dst)
        self._ids.rename(src, dst)

    async def setattr(self, fileid: int, attrs: SetAttrs) -> NFSAttrs:
        """Apply the one settable attribute: size.

        mode, uid, gid and the timestamps are accepted and discarded,
        exactly as the FUSE adapter does -- a mirage backend has nowhere
        to persist them, and refusing would fail ordinary tools.

        Args:
            fileid (int): the file to change.
            attrs (SetAttrs): requested change; only ``size`` acts.

        Returns:
            NFSAttrs: attributes after the change.
        """
        path = self._ids.resolve(fileid)
        size = attrs.size
        if size is not None:
            # Truncate first, clip on success, both under the file's
            # flush lock. Clipping first discarded the pending writes
            # past `size` before knowing the truncate would land, so a
            # denied or transient failure lost bytes the client had been
            # told were durable while the file kept its old length --
            # the same shape as the drop-before-remove bug. The lock is
            # what stops a flush landing in between and re-extending the
            # file with the buffer this is about to clip.
            async with self._flush_lock(fileid):
                await self._core.truncate(path, size)
                self._writes.clip(fileid, size)
        return await self._entry_attrs(fileid, path)

    async def set_size(self, fileid: int, size: int | None) -> NFSAttrs:
        """The wire layer's SETATTR entry point, on primitives.

        The Rust boundary crosses on primitives, so it calls this
        rather than constructing a :class:`SetAttrs`.

        Args:
            fileid (int): the file to change.
            size (int | None): new length, or None when the request
                carried no size and everything is discarded.

        Returns:
            NFSAttrs: attributes after the change.
        """
        return await self.setattr(fileid, SetAttrs(size=size))

    async def symlink(self, dirid: int, name: str, target: str) -> int:
        """Create a symlink and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the link's name.
            target (str): what the link points at, stored verbatim.

        Returns:
            int: the link's file id.
        """
        path = _join(self._ids.resolve(dirid), _component(name))
        await self._core.symlink(path, target)
        return self._ids.alloc(path)

    async def readlink(self, fileid: int) -> str:
        """The target a symlink holds.

        Args:
            fileid (int): the link's file id.

        Returns:
            str: the target as the client should see it -- relative
            targets verbatim, absolute ones rewritten relative to the
            link's directory, since an absolute target names a virtual
            path the client would otherwise resolve against its own
            root and escape the mount.

        Raises:
            OSError: EINVAL when the id does not name a link.
        """
        path = self._ids.resolve(fileid)
        target = self._core.link_target(path)
        if target is None:
            raise OSError(errno.EINVAL, os.strerror(errno.EINVAL), path)
        return target

    async def readdir(self,
                      dirid: int,
                      cookie: int = 0,
                      max_entries: int | None = None) -> list[DirEntry]:
        """List a directory, resuming after the entry ``cookie`` names.

        The cookie is the last-seen entry's fileid: the server crate
        derives the wire cookie from each entry's id and hands it back
        as ``start_after``. Resume keys on identity, never on comparing
        magnitudes -- ids are minted in access order, so a later entry
        may carry a smaller id than an earlier one.

        Args:
            dirid (int): the directory to list.
            cookie (int): fileid of the last entry seen; 0 starts at
                the top.
            max_entries (int | None): cap on entries returned.

        Returns:
            list[DirEntry]: name, fileid, cookie and attributes, with
            ``cookie == fileid`` on every entry.
        """
        path = self._ids.resolve(dirid)
        # The core joins each child and describes it, so this loop adds
        # only what NFSv3 has and mirage does not: the file id, and the
        # cookie a client resumes from. "." and ".." are absent from the
        # core's per-entry listing because NFSv3 carries them in the
        # reply header rather than as entries.
        # Resume by NAME, not by scanning for the cookie's fileid. That
        # scan only ever cleared itself on an exact match, so a cookie
        # whose entry had since been removed matched nothing, every
        # remaining entry was skipped, and the empty page read to the
        # client as end-of-directory: `ls` on a directory another writer
        # was touching silently lost its tail. A name comparison needs
        # the entry to have existed, not to still exist.
        after = None
        if cookie != 0:
            resume_path = self._ids.cookie_path(cookie)
            if resume_path is None:
                raise StaleHandleError(f"unknown readdir cookie: {cookie}")
            after = resume_path.rsplit("/", 1)[-1]
        entries: list[DirEntry] = []
        for entry in await self._core.readdir_entries(path):
            if after is not None and entry.name <= after:
                continue
            fileid = self._ids.alloc(entry.path)
            entries.append(
                DirEntry(name=entry.name,
                         fileid=fileid,
                         cookie=fileid,
                         attrs=self._wire_attrs(fileid, entry.attrs)))
            if max_entries is not None and len(entries) >= max_entries:
                break
        return entries

    async def _drain_to_ceiling(self) -> None:
        """Flush the biggest buffers until the total is under the cap.

        ``max_buffered_bytes`` bounds one handle, so N files written at
        once cost N times it and nothing bounded the sum: a ``cp -r`` of
        many large files grew the process without limit, and the idle
        sweep only ran on its timer. Biggest first, so the fewest stores
        get back under.
        """
        ceiling = self._config.max_total_buffered_bytes
        if self._writes.total_bytes() <= ceiling:
            return
        for fileid in self._writes.heaviest_ids():
            if self._writes.total_bytes() <= ceiling:
                return
            await self._flush_or_drop(fileid)

    async def flush(self, fileid: int) -> None:
        """Store one file's buffered writes.

        Args:
            fileid (int): the file to flush.
        """
        if self._writes.has_pending(fileid):
            await self._flush_one(fileid, self._ids.resolve(fileid))

    async def flush_all(self) -> None:
        """Store every buffered write.

        Used by the idle sweep and at teardown. A file id that went
        stale under a pending buffer is dropped rather than raised: one
        dead entry must not stop the rest from being stored.
        """
        for fileid in self._writes.pending_ids():
            await self._flush_or_drop(fileid)

    async def flush_idle(self) -> None:
        """Store writes untouched for longer than the idle window."""
        for fileid in self._writes.idle_ids(self._config.idle_flush_seconds):
            await self._flush_or_drop(fileid)

    async def _flush_or_drop(self, fileid: int) -> None:
        """Flush one file id, discarding its writes if the id went stale.

        A sweep covers every buffered id, so one entry whose path is
        gone must not stop the others from being stored.

        Args:
            fileid (int): the file to flush.
        """
        try:
            path = self._ids.resolve(fileid)
        except StaleHandleError:
            self._writes.drop(fileid)
            self._flush_locks.pop(fileid, None)
            return
        await self._flush_one(fileid, path)

    @asynccontextmanager
    async def _flush_lock(self, fileid: int) -> AsyncIterator[None]:
        """Hold the lock serializing one file's flushes.

        Kept here rather than on ``WriteBuffer``: the state holders are
        await-free by design, and a lock inside one would not help
        anyway -- what has to be atomic spans a read, a take and a
        write, which only the caller can bracket.

        Reference-counted so the table cannot grow forever. Ids are
        never reused, so a lock left behind per written file is an
        unbounded map on a long-lived mount -- the same complaint as an
        unbounded write buffer, one level down. The count is raised
        before acquiring, so a coroutine merely *waiting* for the lock
        keeps it alive: dropping it there would hand the next caller a
        fresh lock and let two flushes of one file run at once, which is
        the race this exists to prevent.

        Args:
            fileid (int): the file whose flushes to serialize.

        Yields:
            None: with the lock held.
        """
        entry = self._flush_locks.get(fileid)
        if entry is None:
            entry = _FlushLock(asyncio.Lock(), 0)
            self._flush_locks[fileid] = entry
        entry.waiters += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.waiters -= 1
            if entry.waiters == 0:
                self._flush_locks.pop(fileid, None)

    async def _flush_one(self, fileid: int, path: str) -> None:
        """Store one file's buffered writes, one flush at a time.

        Read, take and write are one critical section. Without it two
        flushes of the same file -- an idle timer against a size
        trigger, or either against teardown -- each read the same stored
        base and take different batches, and whichever store lands last
        drops the other batch. The client was told those bytes were
        durable.

        Args:
            fileid (int): the file to flush.
            path (str): its path, resolved by the caller.
        """
        async with self._flush_lock(fileid):
            base = await self._read_base(path)
            pending = self._writes.take(fileid)
            if not pending:
                return
            try:
                await self._core.store(path, WriteBuffer.merge(base, pending))
            except Exception:
                # Taken up front, this batch was gone the moment the
                # store raised -- and every one of its writes had been
                # answered FILE_SYNC, so the client believes they are
                # durable and will never send them again. Put them back
                # and let the idle sweep retry; the raise still reaches
                # the caller.
                self._writes.requeue(fileid, pending)
                raise

    async def _read_base(self, path: str) -> bytes:
        try:
            return await self._core.read(path, _WHOLE_FILE, 0, None)
        except (FileNotFoundError, IsADirectoryError):
            return b""

    async def _entry_attrs(self, fileid: int, path: str) -> NFSAttrs:
        """The wire attributes for one entry, over the core's POSIX ones.

        The core decides what the entry *is* -- a link reported as a
        link rather than followed, a size-unknown file reported as 0,
        macOS metadata refused -- and this converts that answer into the
        three facts NFSv3 puts on the wire, plus the size a client
        should see, which counts writes buffered but not yet stored.

        ``attrs_for`` rather than ``getattr``: the id was minted by a
        lookup that already applied the name policy, and re-applying it
        here would disappear an entry the client just created.

        Args:
            fileid (int): the entry's id.
            path (str): the entry's mount-relative path.
        """
        return self._wire_attrs(fileid, await self._core.attrs_for(path))

    def _wire_attrs(self, fileid: int, entry: MountAttrs) -> NFSAttrs:
        """Convert one POSIX row into the facts NFSv3 puts on the wire.

        Split from :meth:`_entry_attrs` so a listing, which already has
        every row from the core, converts them without a second stat per
        name. Sync, and therefore safe to call inside a listing loop.

        Args:
            fileid (int): the entry's id.
            entry (MountAttrs): the row the core answered with.

        Returns:
            NFSAttrs: the wire attributes for that entry.
        """
        mode = entry.mode
        is_dir = bool(stat_bits.S_ISDIR(mode))
        size = 0 if is_dir else self._writes.pending_size(fileid, entry.size)
        return NFSAttrs(fileid=fileid,
                        size=size,
                        is_dir=is_dir,
                        is_symlink=bool(stat_bits.S_ISLNK(mode)),
                        mode=mode & 0o7777,
                        mtime_epoch=float(entry.mtime))
