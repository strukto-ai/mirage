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

import functools
import logging
import posixpath
import struct
import time
from dataclasses import dataclass
from typing import Any, Callable, Literal

from mirage.runtime.errors import CrossMountError
from mirage.runtime.handles import FileHandle, FileTable
from mirage.runtime.handles.mode import OpenMode
from mirage.runtime.open import apply_open
from mirage.runtime.types import VFSStat
from mirage.runtime.wasm.constants import (
    FDFLAG_APPEND,
    FST_ATIM,
    FST_ATIM_NOW,
    FST_MTIM,
    FST_MTIM_NOW,
    FT_CHR,
    FT_DIR,
    FT_REG,
    LOOKUP_SYMLINK_FOLLOW,
    OFLAG_CREAT,
    OFLAG_DIRECTORY,
    OFLAG_EXCL,
    OFLAG_TRUNC,
    RIGHT_FD_WRITE,
)
from mirage.runtime.wasm.errors import (
    EBADF,
    EINVAL,
    EIO,
    ENOENT,
    ENOTDIR,
    LINK_REFUSAL,
    OK,
    errno_for,
)
from mirage.runtime.wasm.list import pack_dirent
from mirage.runtime.wasm.loader import Func, FuncType, ValType, wasmtime
from mirage.runtime.wasm.slab import install_slab_lock
from mirage.runtime.wasm.stat import (
    filetype_of,
    pack_fdstat,
    pack_filestat,
    pack_prestat,
)
from mirage.runtime.wasm.view import WasmView
from mirage.utils.dates import timestamp_iso

logger = logging.getLogger(__name__)

FdKind = Literal["stdin", "stdout", "stderr", "dir", "file"]


def unpack_iovs(raw: bytes, count: int) -> list[tuple[int, int]]:
    """Decode an iovec array into (pointer, length) pairs.

    Args:
        raw (bytes): the iovec array bytes read from guest memory.
        count (int): number of iovec records.
    """
    return [struct.unpack_from("<II", raw, i * 8) for i in range(count)]


def pack_u32(value: int) -> bytes:
    return struct.pack("<I", value)


def pack_u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def _stamp(
    fst_flags: int, set_bit: int, now_bit: int, value: int, now: float
) -> str | None:
    """One utimensat stamp as ISO text, None when the call omits it.

    preview1 splits each of the two stamps into "write the argument" and
    "write the host clock" bits, and neither set is UTIME_OMIT: leave
    that field alone.

    Args:
        fst_flags (int): the call's fstflags bag.
        set_bit (int): the FST_*TIM bit for this stamp.
        now_bit (int): the FST_*TIM_NOW bit for this stamp.
        value (int): the argument's epoch nanoseconds.
        now (float): the host clock, read once for both stamps.
    """
    if fst_flags & now_bit:
        return timestamp_iso(now)
    if fst_flags & set_bit:
        return timestamp_iso(value / 1_000_000_000)
    return None


def _call_guarded(
    fn: Callable[..., Any], caller: "wasmtime.Caller", *args: int
) -> int:
    """Run a preview1 host function, mapping every failure to a guest errno.

    Filesystem-shaped exceptions get their own errno. Anything else, a
    backend's upstream error on one record most often, is EIO: a
    syscall has no other channel to say it failed, and trapping instead
    killed the whole run over one file the guest could have skipped.
    The TypeScript hosts answer the same (quickjs's ``errnoFor``,
    pyodide's read-through) and so does the FUSE classifier.

    Args:
        fn (Callable): bound WasiFs method for one preview1 import.
        caller (wasmtime.Caller): wasmtime caller for guest memory access.
    """
    try:
        return fn(caller, *args)
    except (OSError, ValueError, NotImplementedError, CrossMountError) as exc:
        return errno_for(exc)
    except Exception as exc:
        logger.debug("wasi host call failed: %r", exc)
        return EIO


def _open_mode(oflags: int, rights_base: int, fdflags: int) -> OpenMode:
    """The open facts preview1 spells as oflags, rights and fdflags.

    Args:
        oflags (int): the open's oflags bag.
        rights_base (int): the rights the guest asked for.
        fdflags (int): the descriptor flags.
    """
    create = bool(oflags & OFLAG_CREAT)
    truncate = bool(oflags & OFLAG_TRUNC)
    append = bool(fdflags & FDFLAG_APPEND)
    return OpenMode(
        readable=True,
        writable=create
        or truncate
        or append
        or bool(rights_base & RIGHT_FD_WRITE),
        truncate=truncate,
        append=append,
        create=create,
        exclusive=create and bool(oflags & OFLAG_EXCL),
        binary=True,
    )


@dataclass(slots=True)
class FdEntry:
    """One guest fd: a directory, a stdio stream, or a buffered file.

    Args:
        kind (FdKind): which of the five fd shapes this is.
        handle (FileHandle | None): the shared file handle; set for
            files and for stdin (read-only bytes), None otherwise.
        path (str): guest path, for dirs and files.
        preopen (bool): the preopened root dir, which close refuses.
        dirents (list[tuple[str, int]] | None): a dir fd's cached
            listing, filled on the first fd_readdir.
        stat (VFSStat | None): a file's stat at open, for mtime.
    """

    kind: FdKind
    handle: FileHandle | None = None
    path: str = ""
    preopen: bool = False
    dirents: list[tuple[str, int]] | None = None
    stat: VFSStat | None = None


class WasiFs:
    """Preview1 filesystem host functions over a WasmView router.

    One instance per run: owns the guest fd table (stdin/stdout/stderr
    plus one preopen at "/"), keeps each open file's writes until its
    close (or the guest's exit), and translates the preview1 ABI
    (iovecs, filestats, dirents) for the router. Installed over the
    linker's native WASI so only filesystem imports are shadowed;
    clocks, args, env, and randomness stay native.
    """

    def __init__(self, fs: WasmView, stdin: bytes) -> None:
        self._fs = fs
        self.stdout = bytearray()
        self.stderr = bytearray()
        self._memory: "wasmtime.Memory | None" = None
        self._fds: FileTable[FdEntry] = FileTable(first_id=4)
        self._fds.set(
            0,
            FdEntry(kind="stdin", handle=FileHandle.of_bytes("", stdin)),
        )
        self._fds.set(1, FdEntry(kind="stdout"))
        self._fds.set(2, FdEntry(kind="stderr"))
        self._fds.set(3, FdEntry(kind="dir", path="/", preopen=True))

    # -- guest memory -----------------------------------------------------

    def _mem(self, caller: "wasmtime.Caller") -> "wasmtime.Memory":
        if self._memory is None:
            memory = caller.get("memory")
            if not isinstance(memory, wasmtime.Memory):
                raise ValueError("wasm module exports no memory")
            self._memory = memory
        return self._memory

    def _load(self, caller: "wasmtime.Caller", ptr: int, n: int) -> bytes:
        return bytes(self._mem(caller).read(caller, ptr, ptr + n))

    def _store(self, caller: "wasmtime.Caller", ptr: int, data: bytes) -> None:
        self._mem(caller).write(caller, data, ptr)

    def _iovs(
        self, caller: "wasmtime.Caller", ptr: int, count: int
    ) -> list[tuple[int, int]]:
        return unpack_iovs(self._load(caller, ptr, count * 8), count)

    def _path_arg(
        self, caller: "wasmtime.Caller", dirfd: int, ptr: int, length: int
    ) -> str | None:
        entry = self._fds.get(dirfd)
        if entry is None or entry.kind != "dir":
            return None
        rel = self._load(caller, ptr, length).decode()
        base = entry.path
        joined = rel if rel.startswith("/") else posixpath.join(base, rel)
        normed = posixpath.normpath(joined)
        return normed if normed.startswith("/") else "/" + normed

    @staticmethod
    def _ino(path: str) -> int:
        return hash(path) & (2**63 - 1)

    # -- fd lookups -------------------------------------------------------

    def _handle(self, fd: int) -> FileHandle | None:
        """The buffered handle under `fd`: a file's, or stdin's.

        Args:
            fd (int): the guest fd.
        """
        entry = self._fds.get(fd)
        return entry.handle if entry is not None else None

    def _file_handle(self, fd: int) -> FileHandle | None:
        """The handle under `fd` only when it is a regular file.

        Args:
            fd (int): the guest fd.
        """
        entry = self._fds.get(fd)
        if entry is None or entry.kind != "file":
            return None
        return entry.handle

    # -- prestat ----------------------------------------------------------

    def fd_prestat_get(
        self, caller: "wasmtime.Caller", fd: int, buf: int
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.preopen:
            return EBADF
        self._store(caller, buf, pack_prestat(len(entry.path.encode())))
        return OK

    def fd_prestat_dir_name(
        self, caller: "wasmtime.Caller", fd: int, ptr: int, length: int
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.preopen:
            return EBADF
        self._store(caller, ptr, entry.path.encode()[:length])
        return OK

    # -- open/close -------------------------------------------------------

    def path_open(
        self,
        caller: "wasmtime.Caller",
        dirfd: int,
        dirflags: int,
        ptr: int,
        length: int,
        oflags: int,
        rights_base: int,
        rights_inherit: int,
        fdflags: int,
        out: int,
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        if oflags & OFLAG_DIRECTORY:
            st = self._fs.stat_or_none(path)
            if st is None:
                return ENOENT
            if not st.is_dir:
                return ENOTDIR
            return self._open_dir(caller, path, out)
        mode = _open_mode(oflags, rights_base, fdflags)
        try:
            row = apply_open(self._fs, path, mode)
        except IsADirectoryError:
            # POSIX opens a directory read-only without O_DIRECTORY too;
            # only a mode that would write refuses it.
            if mode.writable:
                raise
            return self._open_dir(caller, path, out)
        # Nothing is read at open: the handle fetches what a read lands
        # in. A handle that writes reads the stored bytes, since its
        # writes land on them; a read-only one sees the rendering.
        handle = FileHandle.opened(
            path,
            None
            if row is None
            else lambda offset, size: self._fs.read(
                path, offset=offset, size=size, raw=mode.writable
            ),
            size=0 if row is None else row.size,
            writable=mode.writable,
            append=mode.append,
        )
        # A file the open created or emptied has no row from before it,
        # so fd_filestat_get answers from the row the open left behind.
        if row is None:
            row = self._fs.stat_or_none(path)
        fd = self._fds.add(
            FdEntry(kind="file", handle=handle, path=path, stat=row)
        )
        self._store(caller, out, pack_u32(fd))
        return OK

    def _open_dir(self, caller: "wasmtime.Caller", path: str, out: int) -> int:
        fd = self._fds.add(FdEntry(kind="dir", path=path))
        self._store(caller, out, pack_u32(fd))
        return OK

    def fd_close(self, caller: "wasmtime.Caller", fd: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry.preopen:
            return EBADF
        self._fds.pop(fd)
        h = entry.handle
        if entry.kind == "file" and h is not None and h.dirty:
            self._fs.flush(h.path, h.flush_plan())
        return OK

    def close_all(self) -> list[str]:
        """Send what every file the guest left open still owes the mount.

        A process's writes are in its files whether or not it closed
        them, so the guest's exit flushes each open file the way a
        close would. One that fails does not stop the rest.

        Returns:
            list[str]: one line per file whose writes could not land.
        """
        failures: list[str] = []
        for entry in list(self._fds.values()):
            h = entry.handle
            if entry.kind != "file" or h is None or not h.dirty:
                continue
            try:
                self._fs.flush(h.path, h.flush_plan())
            except (
                OSError,
                ValueError,
                NotImplementedError,
                CrossMountError,
            ) as exc:
                failures.append(f"{h.path}: {exc}")
        return failures

    def fd_renumber(self, caller: "wasmtime.Caller", fd: int, to: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or fd == to:
            return EBADF if entry is None else OK
        self.fd_close(caller, to)
        self._fds.pop(fd)
        self._fds.set(to, entry)
        return OK

    # -- read/write/seek --------------------------------------------------

    def fd_read(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        iovs: int,
        count: int,
        nread: int,
    ) -> int:
        h = self._handle(fd)
        if h is None:
            return EBADF
        total = 0
        for bptr, blen in self._iovs(caller, iovs, count):
            chunk = h.read(blen)
            if chunk:
                self._store(caller, bptr, chunk)
            total += len(chunk)
            if len(chunk) < blen:
                break
        self._store(caller, nread, pack_u32(total))
        return OK

    def fd_pread(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        iovs: int,
        count: int,
        offset: int,
        nread: int,
    ) -> int:
        h = self._file_handle(fd)
        if h is None:
            return EBADF
        total, pos = 0, offset
        for bptr, blen in self._iovs(caller, iovs, count):
            chunk = h.pread(pos, blen)
            if chunk:
                self._store(caller, bptr, chunk)
            pos += len(chunk)
            total += len(chunk)
            if len(chunk) < blen:
                break
        self._store(caller, nread, pack_u32(total))
        return OK

    def fd_write(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        iovs: int,
        count: int,
        nwritten: int,
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        total = 0
        for bptr, blen in self._iovs(caller, iovs, count):
            data = self._load(caller, bptr, blen)
            if entry.kind == "stdout":
                self.stdout += data
            elif entry.kind == "stderr":
                self.stderr += data
            elif entry.kind == "file" and entry.handle is not None:
                if not entry.handle.writable:
                    return EBADF
                entry.handle.write(data)
            else:
                return EINVAL
            total += blen
        self._store(caller, nwritten, pack_u32(total))
        return OK

    def fd_pwrite(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        iovs: int,
        count: int,
        offset: int,
        nwritten: int,
    ) -> int:
        h = self._file_handle(fd)
        if h is None or not h.writable:
            return EBADF
        total, pos = 0, offset
        for bptr, blen in self._iovs(caller, iovs, count):
            data = self._load(caller, bptr, blen)
            h.pwrite(pos, data)
            pos += blen
            total += blen
        self._store(caller, nwritten, pack_u32(total))
        return OK

    def fd_seek(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        offset: int,
        whence: int,
        out: int,
    ) -> int:
        h = self._handle(fd)
        if h is None:
            return EBADF
        # preview1's WHENCE_* numbering is POSIX's 0/1/2, which seek speaks.
        pos = h.seek(offset, whence)
        if pos is None:
            return EINVAL
        self._store(caller, out, pack_u64(pos))
        return OK

    def fd_tell(self, caller: "wasmtime.Caller", fd: int, out: int) -> int:
        h = self._handle(fd)
        if h is None:
            return EBADF
        self._store(caller, out, pack_u64(h.pos))
        return OK

    # -- stat -------------------------------------------------------------

    def fd_fdstat_get(
        self, caller: "wasmtime.Caller", fd: int, buf: int
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        filetype = {"dir": FT_DIR, "file": FT_REG}.get(entry.kind, FT_CHR)
        self._store(caller, buf, pack_fdstat(filetype))
        return OK

    def fd_filestat_get(
        self, caller: "wasmtime.Caller", fd: int, buf: int
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        if entry.kind == "file" and entry.handle is not None:
            row = entry.stat
            packed = pack_filestat(
                entry.handle.size,
                (row.mtime_ns or 0) if row is not None else 0,
                FT_REG,
                self._ino(entry.path),
                None if row is None else row.atime_ns,
            )
        elif entry.kind == "dir":
            st = self._fs.stat(entry.path)
            packed = pack_filestat(
                st.size,
                st.mtime_ns or 0,
                FT_DIR,
                self._ino(entry.path),
                st.atime_ns,
            )
        else:
            packed = pack_filestat(0, 0, FT_CHR, fd)
        self._store(caller, buf, packed)
        return OK

    def path_filestat_get(
        self,
        caller: "wasmtime.Caller",
        dirfd: int,
        flags: int,
        ptr: int,
        length: int,
        buf: int,
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        # The follow bit is how a guest spells stat versus lstat, so it
        # is read rather than ignored: without it every link answered as
        # its target and os.path.islink was always False.
        follow = bool(flags & LOOKUP_SYMLINK_FOLLOW)
        st = self._fs.stat(path) if follow else self._fs.lstat(path)
        packed = pack_filestat(
            st.size,
            st.mtime_ns or 0,
            filetype_of(st),
            self._ino(path),
            st.atime_ns,
        )
        self._store(caller, buf, packed)
        return OK

    def fd_filestat_set_size(
        self, caller: "wasmtime.Caller", fd: int, size: int
    ) -> int:
        h = self._file_handle(fd)
        if h is None or not h.writable:
            return EBADF
        h.truncate(size)
        return OK

    # -- readdir ----------------------------------------------------------

    def fd_readdir(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        buf: int,
        buf_len: int,
        cookie: int,
        used: int,
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry.kind != "dir":
            return EBADF
        if entry.dirents is None:
            entry.dirents = self._fs.readdir(entry.path)
        out = bytearray()
        i = cookie
        while i < len(entry.dirents) and len(out) < buf_len:
            name, filetype = entry.dirents[i]
            record = pack_dirent(i, name.encode(), filetype)
            out += record[: buf_len - len(out)]
            i += 1
        self._store(caller, buf, bytes(out))
        self._store(caller, used, pack_u32(len(out)))
        return OK

    # -- fs mutation ------------------------------------------------------

    def path_unlink_file(
        self, caller: "wasmtime.Caller", dirfd: int, ptr: int, length: int
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.unlink(path)
        return OK

    def path_create_directory(
        self, caller: "wasmtime.Caller", dirfd: int, ptr: int, length: int
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.mkdir(path)
        return OK

    def path_remove_directory(
        self, caller: "wasmtime.Caller", dirfd: int, ptr: int, length: int
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.rmdir(path)
        return OK

    def path_rename(
        self,
        caller: "wasmtime.Caller",
        dirfd: int,
        ptr: int,
        length: int,
        dst_dirfd: int,
        dst_ptr: int,
        dst_length: int,
    ) -> int:
        src = self._path_arg(caller, dirfd, ptr, length)
        dst = self._path_arg(caller, dst_dirfd, dst_ptr, dst_length)
        if src is None or dst is None:
            return EBADF
        self._fs.rename(src, dst)
        return OK

    # -- stubs and no-ops -------------------------------------------------

    def fd_advise(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        offset: int,
        length: int,
        advice: int,
    ) -> int:
        return OK

    def _stored(self, path: str, offset: int, size: int | None) -> bytes:
        return self._fs.read(path, offset=offset, size=size, raw=True)

    def _land(self, entry: FdEntry) -> None:
        """Land a file fd's writes now, as fsync(2) does: the mount and
        every other fd on the path see them before the close, which then
        owes only what came after.

        Args:
            entry (FdEntry): the fd's entry.
        """
        h = entry.handle
        if entry.kind != "file" or h is None or not h.dirty:
            return
        self._fs.flush(h.path, h.flush_plan())
        h.settle(functools.partial(self._stored, h.path))
        entry.stat = self._fs.stat(h.path)

    def fd_datasync(self, caller: "wasmtime.Caller", fd: int) -> int:
        return self.fd_sync(caller, fd)

    def fd_sync(self, caller: "wasmtime.Caller", fd: int) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        self._land(entry)
        return OK

    def fd_fdstat_set_flags(
        self, caller: "wasmtime.Caller", fd: int, flags: int
    ) -> int:
        return OK

    def _set_times(
        self, path: str, atim: int, mtim: int, fst_flags: int, nofollow: bool
    ) -> None:
        """Store the stamps a utimensat-shaped call selects.

        Args:
            path (str): guest-absolute path.
            atim (int): the access time argument, epoch nanoseconds.
            mtim (int): the modification time argument.
            fst_flags (int): which stamps to write, and from where.
            nofollow (bool): stamp a trailing link itself.
        """
        now = time.time()
        atime = _stamp(fst_flags, FST_ATIM, FST_ATIM_NOW, atim, now)
        mtime = _stamp(fst_flags, FST_MTIM, FST_MTIM_NOW, mtim, now)
        if atime is None and mtime is None:
            # No stamp selected is a no-op, not an error: utimensat(2)
            # with two UTIME_OMIT values does nothing and succeeds.
            return
        self._fs.setattr(path, atime=atime, mtime=mtime, nofollow=nofollow)

    def fd_filestat_set_times(
        self,
        caller: "wasmtime.Caller",
        fd: int,
        atim: int,
        mtim: int,
        flags: int,
    ) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry.kind not in ("file", "dir"):
            return EBADF
        # Writes the file still owes land first, or landing them at the
        # close would stamp over the times set here (cp -p).
        self._land(entry)
        self._set_times(entry.path, atim, mtim, flags, nofollow=False)
        if entry.kind == "file":
            entry.stat = self._fs.stat(entry.path)
        return OK

    def path_filestat_set_times(
        self,
        caller: "wasmtime.Caller",
        dirfd: int,
        flags: int,
        ptr: int,
        length: int,
        atim: int,
        mtim: int,
        fst_flags: int,
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._set_times(
            path,
            atim,
            mtim,
            fst_flags,
            nofollow=not (flags & LOOKUP_SYMLINK_FOLLOW),
        )
        return OK

    def path_readlink(
        self,
        caller: "wasmtime.Caller",
        dirfd: int,
        ptr: int,
        length: int,
        buf: int,
        buf_len: int,
        used: int,
    ) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        raw = self._fs.readlink(path).encode()[:buf_len]
        self._store(caller, buf, raw)
        # preview1 truncates rather than refusing a short buffer, and
        # reports what it wrote; a guest that wants the whole target
        # retries with a bigger one, which is what wasi-libc does.
        self._store(caller, used, pack_u32(len(raw)))
        return OK

    def path_link(
        self,
        caller: "wasmtime.Caller",
        old_dirfd: int,
        old_flags: int,
        old_ptr: int,
        old_length: int,
        new_dirfd: int,
        new_ptr: int,
        new_length: int,
    ) -> int:
        # A hard link is a second name for one inode, and nothing above
        # a mount holds that. Which refusal that is is decided once for
        # every surface, not here; see errors.LINK_REFUSAL.
        return LINK_REFUSAL

    def path_symlink(
        self,
        caller: "wasmtime.Caller",
        old_ptr: int,
        old_length: int,
        dirfd: int,
        new_ptr: int,
        new_length: int,
    ) -> int:
        # The old_* pair is the target string, not a path to resolve:
        # a link stores what was typed, so it is read straight out of
        # guest memory and never joined against a preopen.
        target = self._load(caller, old_ptr, old_length).decode()
        path = self._path_arg(caller, dirfd, new_ptr, new_length)
        if path is None:
            return EBADF
        self._fs.symlink(path, target)
        return OK


def _spec() -> dict[str, tuple[list[Any], list[Any]]]:
    i32, i64 = ValType.i32(), ValType.i64()
    return {
        "fd_advise": ([i32, i64, i64, i32], [i32]),
        "fd_close": ([i32], [i32]),
        "fd_datasync": ([i32], [i32]),
        "fd_fdstat_get": ([i32, i32], [i32]),
        "fd_fdstat_set_flags": ([i32, i32], [i32]),
        "fd_filestat_get": ([i32, i32], [i32]),
        "fd_filestat_set_size": ([i32, i64], [i32]),
        "fd_filestat_set_times": ([i32, i64, i64, i32], [i32]),
        "fd_pread": ([i32, i32, i32, i64, i32], [i32]),
        "fd_prestat_get": ([i32, i32], [i32]),
        "fd_prestat_dir_name": ([i32, i32, i32], [i32]),
        "fd_pwrite": ([i32, i32, i32, i64, i32], [i32]),
        "fd_read": ([i32, i32, i32, i32], [i32]),
        "fd_readdir": ([i32, i32, i32, i64, i32], [i32]),
        "fd_renumber": ([i32, i32], [i32]),
        "fd_seek": ([i32, i64, i32, i32], [i32]),
        "fd_sync": ([i32], [i32]),
        "fd_tell": ([i32, i32], [i32]),
        "fd_write": ([i32, i32, i32, i32], [i32]),
        "path_create_directory": ([i32, i32, i32], [i32]),
        "path_filestat_get": ([i32, i32, i32, i32, i32], [i32]),
        "path_filestat_set_times": (
            [i32, i32, i32, i32, i64, i64, i32],
            [i32],
        ),
        "path_link": ([i32, i32, i32, i32, i32, i32, i32], [i32]),
        "path_open": ([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]),
        "path_readlink": ([i32, i32, i32, i32, i32, i32], [i32]),
        "path_remove_directory": ([i32, i32, i32], [i32]),
        "path_rename": ([i32, i32, i32, i32, i32, i32], [i32]),
        "path_symlink": ([i32, i32, i32, i32, i32], [i32]),
        "path_unlink_file": ([i32, i32, i32], [i32]),
    }


def install_wasi_fs(
    linker: "wasmtime.Linker", store: "wasmtime.Store", wasi_fs: WasiFs
) -> None:
    """Shadow the linker's native preview1 filesystem imports.

    Every fd_*/path_* import routes to the WasiFs host functions;
    non-filesystem imports (args, env, clocks, random, poll, proc_exit)
    keep the native define_wasi definitions. These are the only host
    callbacks mirage creates, so the slab lock goes in first.

    Args:
        linker (wasmtime.Linker): linker that already ran define_wasi().
        store (wasmtime.Store): the run's store.
        wasi_fs (WasiFs): per-run host-function table.
    """
    install_slab_lock()
    linker.allow_shadowing = True
    for name, (params, results) in _spec().items():
        method = getattr(wasi_fs, name)
        linker.define(
            store,
            "wasi_snapshot_preview1",
            name,
            Func(
                store,
                FuncType(params, results),
                functools.partial(_call_guarded, method),
                access_caller=True,
            ),
        )
