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
import posixpath
from dataclasses import dataclass
from typing import Any, Callable, Literal

# yapf: disable
from mirage.runtime.errors import CrossMountError
from mirage.runtime.handles import FileHandle, FileTable
from mirage.runtime.wasm.abi import (EBADF, EEXIST, EINVAL, EISDIR, ENOENT,
                                     ENOTDIR, ENOTSUP, FDFLAG_APPEND, FT_CHR,
                                     FT_DIR, FT_REG, OFLAG_CREAT,
                                     OFLAG_DIRECTORY, OFLAG_EXCL, OFLAG_TRUNC,
                                     OK, RIGHT_FD_WRITE, errno_for,
                                     pack_dirent, pack_fdstat, pack_filestat,
                                     pack_prestat, pack_u32, pack_u64,
                                     unpack_iovs)
# yapf: enable
from mirage.runtime.wasm.types import GuestStat
from mirage.runtime.wasm.vfs import WasmVFS

FdKind = Literal["stdin", "stdout", "stderr", "dir", "file"]

wasmtime: Any
Func: Any
FuncType: Any
ValType: Any
try:
    import wasmtime as _wasmtime
    from wasmtime import Func as _Func
    from wasmtime import FuncType as _FuncType
    from wasmtime import ValType as _ValType
except ImportError:
    wasmtime = None
    Func = None
    FuncType = None
    ValType = None
else:
    wasmtime = _wasmtime
    Func = _Func
    FuncType = _FuncType
    ValType = _ValType


def _call_guarded(fn: Callable[..., Any], caller: "wasmtime.Caller", *args:
                  int) -> int:
    """Run a preview1 host function, mapping fs errors to guest errnos.

    Only filesystem-shaped exceptions are mapped; anything else
    propagates and traps the run loudly.

    Args:
        fn (Callable): bound WasiFs method for one preview1 import.
        caller (wasmtime.Caller): wasmtime caller for guest memory access.
    """
    try:
        return fn(caller, *args)
    except (OSError, ValueError, NotImplementedError, CrossMountError) as exc:
        return errno_for(exc)


@dataclass(slots=True)
class FdEntry:
    """One guest fd: a directory, a stdio stream, or a buffered file.

    Args:
        kind (FdKind): which of the five fd shapes this is.
        handle (FileHandle | None): the shared buffered handle; set for
            files and for stdin (a read-only buffer), None otherwise.
        path (str): guest path, for dirs and files.
        preopen (bool): the preopened root dir, which close refuses.
        dirents (list[tuple[str, int]] | None): a dir fd's cached
            listing, filled on the first fd_readdir.
        stat (GuestStat | None): a file's stat at open, for mtime.
    """

    kind: FdKind
    handle: FileHandle | None = None
    path: str = ""
    preopen: bool = False
    dirents: list[tuple[str, int]] | None = None
    stat: GuestStat | None = None


class WasiFs:
    """Preview1 filesystem host functions over a WasmVFS router.

    One instance per run: owns the guest fd table (stdin/stdout/stderr
    plus one preopen at "/"), buffers whole files between open and
    close, and translates the preview1 ABI (iovecs, filestats, dirents)
    for the router. Installed over the linker's native WASI so only
    filesystem imports are shadowed; clocks, args, env, and randomness
    stay native.
    """

    def __init__(self, fs: WasmVFS, stdin: bytes) -> None:
        self._fs = fs
        self.stdout = bytearray()
        self.stderr = bytearray()
        self._memory: "wasmtime.Memory | None" = None
        self._fds: FileTable[FdEntry] = FileTable(first_id=4)
        self._fds.set(
            0,
            FdEntry(kind="stdin",
                    handle=FileHandle(path="", buf=bytearray(stdin))))
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

    def _iovs(self, caller: "wasmtime.Caller", ptr: int,
              count: int) -> list[tuple[int, int]]:
        return unpack_iovs(self._load(caller, ptr, count * 8), count)

    def _path_arg(self, caller: "wasmtime.Caller", dirfd: int, ptr: int,
                  length: int) -> str | None:
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

    def fd_prestat_get(self, caller: "wasmtime.Caller", fd: int,
                       buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.preopen:
            return EBADF
        self._store(caller, buf, pack_prestat(len(entry.path.encode())))
        return OK

    def fd_prestat_dir_name(self, caller: "wasmtime.Caller", fd: int, ptr: int,
                            length: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.preopen:
            return EBADF
        self._store(caller, ptr, entry.path.encode()[:length])
        return OK

    # -- open/close -------------------------------------------------------

    def path_open(self, caller: "wasmtime.Caller", dirfd: int, dirflags: int,
                  ptr: int, length: int, oflags: int, rights_base: int,
                  rights_inherit: int, fdflags: int, out: int) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        st = self._fs.stat_or_none(path)
        if oflags & OFLAG_DIRECTORY or (st is not None and st.is_dir
                                        and not oflags & OFLAG_CREAT):
            if st is None:
                return ENOENT
            if not st.is_dir:
                return ENOTDIR
            fd = self._fds.add(FdEntry(kind="dir", path=path))
            self._store(caller, out, pack_u32(fd))
            return OK
        if st is not None and st.is_dir:
            return EISDIR
        if oflags & OFLAG_CREAT and oflags & OFLAG_EXCL and st is not None:
            return EEXIST
        if st is None and not oflags & OFLAG_CREAT:
            return ENOENT
        writable = (bool(oflags & (OFLAG_CREAT | OFLAG_TRUNC))
                    or bool(rights_base & RIGHT_FD_WRITE)
                    or bool(fdflags & FDFLAG_APPEND))
        if st is None:
            # Created through the workspace now, so write modes and a
            # missing parent answer at open time, not at close.
            self._fs.create(path)
            data = b""
        elif oflags & OFLAG_TRUNC:
            self._fs.truncate(path)
            data = b""
        else:
            data = self._fs.read(path)
        handle = FileHandle.opened(path,
                                   data,
                                   writable=writable,
                                   append=bool(fdflags & FDFLAG_APPEND))
        fd = self._fds.add(
            FdEntry(kind="file", handle=handle, path=path, stat=st))
        self._store(caller, out, pack_u32(fd))
        return OK

    def fd_close(self, caller: "wasmtime.Caller", fd: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry.preopen:
            return EBADF
        self._fds.pop(fd)
        h = entry.handle
        if entry.kind == "file" and h is not None and h.dirty:
            self._fs.flush(h.path, h.base_len, h.low_write, h.buf)
        return OK

    def fd_renumber(self, caller: "wasmtime.Caller", fd: int, to: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or fd == to:
            return EBADF if entry is None else OK
        self.fd_close(caller, to)
        self._fds.pop(fd)
        self._fds.set(to, entry)
        return OK

    # -- read/write/seek --------------------------------------------------

    def fd_read(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                count: int, nread: int) -> int:
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

    def fd_pread(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                 count: int, offset: int, nread: int) -> int:
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

    def fd_write(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                 count: int, nwritten: int) -> int:
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

    def fd_pwrite(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                  count: int, offset: int, nwritten: int) -> int:
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

    def fd_seek(self, caller: "wasmtime.Caller", fd: int, offset: int,
                whence: int, out: int) -> int:
        h = self._handle(fd)
        if h is None:
            return EBADF
        # abi WHENCE_* numbering is POSIX's 0/1/2, which seek speaks.
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

    def fd_fdstat_get(self, caller: "wasmtime.Caller", fd: int,
                      buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        filetype = {"dir": FT_DIR, "file": FT_REG}.get(entry.kind, FT_CHR)
        self._store(caller, buf, pack_fdstat(filetype))
        return OK

    def fd_filestat_get(self, caller: "wasmtime.Caller", fd: int,
                        buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        if entry.kind == "file" and entry.handle is not None:
            mtime = entry.stat.mtime_ns if entry.stat is not None else 0
            packed = pack_filestat(len(entry.handle.buf), mtime, FT_REG,
                                   self._ino(entry.path))
        elif entry.kind == "dir":
            st = self._fs.stat(entry.path)
            packed = pack_filestat(st.size, st.mtime_ns, FT_DIR,
                                   self._ino(entry.path))
        else:
            packed = pack_filestat(0, 0, FT_CHR, fd)
        self._store(caller, buf, packed)
        return OK

    def path_filestat_get(self, caller: "wasmtime.Caller", dirfd: int,
                          flags: int, ptr: int, length: int, buf: int) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        st = self._fs.stat(path)
        packed = pack_filestat(st.size,
                               st.mtime_ns, FT_DIR if st.is_dir else FT_REG,
                               self._ino(path))
        self._store(caller, buf, packed)
        return OK

    def fd_filestat_set_size(self, caller: "wasmtime.Caller", fd: int,
                             size: int) -> int:
        h = self._file_handle(fd)
        if h is None or not h.writable:
            return EBADF
        h.truncate(size)
        return OK

    # -- readdir ----------------------------------------------------------

    def fd_readdir(self, caller: "wasmtime.Caller", fd: int, buf: int,
                   buf_len: int, cookie: int, used: int) -> int:
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
            out += record[:buf_len - len(out)]
            i += 1
        self._store(caller, buf, bytes(out))
        self._store(caller, used, pack_u32(len(out)))
        return OK

    # -- fs mutation ------------------------------------------------------

    def path_unlink_file(self, caller: "wasmtime.Caller", dirfd: int, ptr: int,
                         length: int) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.unlink(path)
        return OK

    def path_create_directory(self, caller: "wasmtime.Caller", dirfd: int,
                              ptr: int, length: int) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.mkdir(path)
        return OK

    def path_remove_directory(self, caller: "wasmtime.Caller", dirfd: int,
                              ptr: int, length: int) -> int:
        path = self._path_arg(caller, dirfd, ptr, length)
        if path is None:
            return EBADF
        self._fs.rmdir(path)
        return OK

    def path_rename(self, caller: "wasmtime.Caller", dirfd: int, ptr: int,
                    length: int, dst_dirfd: int, dst_ptr: int,
                    dst_length: int) -> int:
        src = self._path_arg(caller, dirfd, ptr, length)
        dst = self._path_arg(caller, dst_dirfd, dst_ptr, dst_length)
        if src is None or dst is None:
            return EBADF
        self._fs.rename(src, dst)
        return OK

    # -- stubs and no-ops -------------------------------------------------

    def fd_advise(self, caller: "wasmtime.Caller", fd: int, offset: int,
                  length: int, advice: int) -> int:
        return OK

    def fd_datasync(self, caller: "wasmtime.Caller", fd: int) -> int:
        return OK

    def fd_sync(self, caller: "wasmtime.Caller", fd: int) -> int:
        return OK

    def fd_fdstat_set_flags(self, caller: "wasmtime.Caller", fd: int,
                            flags: int) -> int:
        return OK

    def fd_filestat_set_times(self, caller: "wasmtime.Caller", fd: int,
                              atim: int, mtim: int, flags: int) -> int:
        return OK

    def path_filestat_set_times(self, caller: "wasmtime.Caller", dirfd: int,
                                flags: int, ptr: int, length: int, atim: int,
                                mtim: int, fst_flags: int) -> int:
        return OK

    def path_readlink(self, caller: "wasmtime.Caller", dirfd: int, ptr: int,
                      length: int, buf: int, buf_len: int, used: int) -> int:
        # Workspace links resolve inside dispatch; the guest never sees
        # a symlink, so readlink on any path answers "not a symlink".
        return EINVAL

    def path_link(self, caller: "wasmtime.Caller", old_dirfd: int,
                  old_flags: int, old_ptr: int, old_length: int,
                  new_dirfd: int, new_ptr: int, new_length: int) -> int:
        return ENOTSUP

    def path_symlink(self, caller: "wasmtime.Caller", old_ptr: int,
                     old_length: int, dirfd: int, new_ptr: int,
                     new_length: int) -> int:
        return ENOTSUP


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
        "path_filestat_set_times": ([i32, i32, i32, i32, i64, i64,
                                     i32], [i32]),
        "path_link": ([i32, i32, i32, i32, i32, i32, i32], [i32]),
        "path_open": ([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]),
        "path_readlink": ([i32, i32, i32, i32, i32, i32], [i32]),
        "path_remove_directory": ([i32, i32, i32], [i32]),
        "path_rename": ([i32, i32, i32, i32, i32, i32], [i32]),
        "path_symlink": ([i32, i32, i32, i32, i32], [i32]),
        "path_unlink_file": ([i32, i32, i32], [i32]),
    }


def install_wasi_fs(linker: "wasmtime.Linker", store: "wasmtime.Store",
                    wasi_fs: WasiFs) -> None:
    """Shadow the linker's native preview1 filesystem imports.

    Every fd_*/path_* import routes to the WasiFs host functions;
    non-filesystem imports (args, env, clocks, random, poll, proc_exit)
    keep the native define_wasi definitions.

    Args:
        linker (wasmtime.Linker): linker that already ran define_wasi().
        store (wasmtime.Store): the run's store.
        wasi_fs (WasiFs): per-run host-function table.
    """
    linker.allow_shadowing = True
    for name, (params, results) in _spec().items():
        method = getattr(wasi_fs, name)
        linker.define(
            store, "wasi_snapshot_preview1", name,
            Func(store,
                 FuncType(params, results),
                 functools.partial(_call_guarded, method),
                 access_caller=True))
