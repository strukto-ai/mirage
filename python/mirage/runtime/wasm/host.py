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
from typing import Callable

try:
    import wasmtime
    from wasmtime import Func, FuncType, ValType
except ImportError:
    wasmtime = None  # type: ignore[assignment]
    Func = None  # type: ignore[misc, assignment]
    FuncType = None  # type: ignore[misc, assignment]
    ValType = None  # type: ignore[misc, assignment]

# yapf: disable
from mirage.runtime.wasm.abi import (EBADF, EEXIST, EINVAL, EISDIR, ENOENT,
                                     ENOTDIR, ENOTSUP, FDFLAG_APPEND, FT_CHR,
                                     FT_DIR, FT_REG, OFLAG_CREAT,
                                     OFLAG_DIRECTORY, OFLAG_EXCL, OFLAG_TRUNC,
                                     OK, RIGHT_FD_WRITE, WHENCE_CUR,
                                     WHENCE_END, WHENCE_SET, errno_for,
                                     pack_dirent, pack_fdstat, pack_filestat,
                                     pack_prestat, pack_u32, pack_u64,
                                     unpack_iovs)
# yapf: enable
from mirage.runtime.wasm.fs import GuestFs


def _call_guarded(fn: Callable, caller: "wasmtime.Caller", *args: int) -> int:
    """Run a preview1 host function, mapping fs errors to guest errnos.

    Only filesystem-shaped exceptions are mapped; anything else
    propagates and traps the run loudly.

    Args:
        fn (Callable): bound WasiFs method for one preview1 import.
        caller (wasmtime.Caller): wasmtime caller for guest memory access.
    """
    try:
        return fn(caller, *args)
    except (OSError, ValueError, NotImplementedError) as exc:
        return errno_for(exc)


class WasiFs:
    """Preview1 filesystem host functions over a GuestFs router.

    One instance per run: owns the guest fd table (stdin/stdout/stderr
    plus one preopen at "/"), buffers whole files between open and
    close, and translates the preview1 ABI (iovecs, filestats, dirents)
    for the router. Installed over the linker's native WASI so only
    filesystem imports are shadowed; clocks, args, env, and randomness
    stay native.
    """

    def __init__(self, fs: GuestFs, stdin: bytes) -> None:
        self._fs = fs
        self.stdout = bytearray()
        self.stderr = bytearray()
        self._memory: "wasmtime.Memory | None" = None
        self._next_fd = 4
        self._fds: dict[int, dict] = {
            0: {
                "kind": "stdin",
                "buf": stdin,
                "pos": 0
            },
            1: {
                "kind": "stdout"
            },
            2: {
                "kind": "stderr"
            },
            3: {
                "kind": "dir",
                "path": "/",
                "preopen": True,
                "dirents": None
            },
        }

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
        if entry is None or entry["kind"] != "dir":
            return None
        rel = self._load(caller, ptr, length).decode()
        base = entry["path"]
        joined = rel if rel.startswith("/") else posixpath.join(base, rel)
        normed = posixpath.normpath(joined)
        return normed if normed.startswith("/") else "/" + normed

    def _alloc(self, entry: dict) -> int:
        fd = self._next_fd
        self._next_fd += 1
        self._fds[fd] = entry
        return fd

    @staticmethod
    def _ino(path: str) -> int:
        return hash(path) & (2**63 - 1)

    # -- prestat ----------------------------------------------------------

    def fd_prestat_get(self, caller: "wasmtime.Caller", fd: int,
                       buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.get("preopen"):
            return EBADF
        self._store(caller, buf, pack_prestat(len(entry["path"].encode())))
        return OK

    def fd_prestat_dir_name(self, caller: "wasmtime.Caller", fd: int, ptr: int,
                            length: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or not entry.get("preopen"):
            return EBADF
        self._store(caller, ptr, entry["path"].encode()[:length])
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
            fd = self._alloc({"kind": "dir", "path": path, "dirents": None})
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
            buf = bytearray()
        elif oflags & OFLAG_TRUNC:
            self._fs.truncate(path)
            buf = bytearray()
        else:
            buf = bytearray(self._fs.read(path))
        fd = self._alloc({
            "kind": "file",
            "path": path,
            "buf": buf,
            "pos": len(buf) if fdflags & FDFLAG_APPEND else 0,
            "dirty": False,
            "writable": writable,
            "stat": st,
        })
        self._store(caller, out, pack_u32(fd))
        return OK

    def fd_close(self, caller: "wasmtime.Caller", fd: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry.get("preopen"):
            return EBADF
        del self._fds[fd]
        if entry["kind"] == "file" and entry["dirty"]:
            self._fs.write(entry["path"], bytes(entry["buf"]))
        return OK

    def fd_renumber(self, caller: "wasmtime.Caller", fd: int, to: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or fd == to:
            return EBADF if entry is None else OK
        self.fd_close(caller, to)
        self._fds[to] = self._fds.pop(fd)
        return OK

    # -- read/write/seek --------------------------------------------------

    def fd_read(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                count: int, nread: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or "buf" not in entry:
            return EBADF
        total = 0
        for bptr, blen in self._iovs(caller, iovs, count):
            chunk = bytes(entry["buf"][entry["pos"]:entry["pos"] + blen])
            if chunk:
                self._store(caller, bptr, chunk)
            entry["pos"] += len(chunk)
            total += len(chunk)
            if len(chunk) < blen:
                break
        self._store(caller, nread, pack_u32(total))
        return OK

    def fd_pread(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                 count: int, offset: int, nread: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry["kind"] != "file":
            return EBADF
        total, pos = 0, offset
        for bptr, blen in self._iovs(caller, iovs, count):
            chunk = bytes(entry["buf"][pos:pos + blen])
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
            if entry["kind"] == "stdout":
                self.stdout += data
            elif entry["kind"] == "stderr":
                self.stderr += data
            elif entry["kind"] == "file":
                if not entry["writable"]:
                    return EBADF
                buf, pos = entry["buf"], entry["pos"]
                if pos > len(buf):
                    buf += b"\0" * (pos - len(buf))
                buf[pos:pos + blen] = data
                entry["pos"] += blen
                entry["dirty"] = True
            else:
                return EINVAL
            total += blen
        self._store(caller, nwritten, pack_u32(total))
        return OK

    def fd_pwrite(self, caller: "wasmtime.Caller", fd: int, iovs: int,
                  count: int, offset: int, nwritten: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry["kind"] != "file":
            return EBADF
        if not entry["writable"]:
            return EBADF
        total, pos = 0, offset
        for bptr, blen in self._iovs(caller, iovs, count):
            data = self._load(caller, bptr, blen)
            buf = entry["buf"]
            if pos > len(buf):
                buf += b"\0" * (pos - len(buf))
            buf[pos:pos + blen] = data
            pos += blen
            total += blen
            entry["dirty"] = True
        self._store(caller, nwritten, pack_u32(total))
        return OK

    def fd_seek(self, caller: "wasmtime.Caller", fd: int, offset: int,
                whence: int, out: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or "buf" not in entry:
            return EBADF
        base = {
            WHENCE_SET: 0,
            WHENCE_CUR: entry["pos"],
            WHENCE_END: len(entry["buf"]),
        }.get(whence)
        if base is None or base + offset < 0:
            return EINVAL
        entry["pos"] = base + offset
        self._store(caller, out, pack_u64(entry["pos"]))
        return OK

    def fd_tell(self, caller: "wasmtime.Caller", fd: int, out: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or "pos" not in entry:
            return EBADF
        self._store(caller, out, pack_u64(entry["pos"]))
        return OK

    # -- stat -------------------------------------------------------------

    def fd_fdstat_get(self, caller: "wasmtime.Caller", fd: int,
                      buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        filetype = {"dir": FT_DIR, "file": FT_REG}.get(entry["kind"], FT_CHR)
        self._store(caller, buf, pack_fdstat(filetype))
        return OK

    def fd_filestat_get(self, caller: "wasmtime.Caller", fd: int,
                        buf: int) -> int:
        entry = self._fds.get(fd)
        if entry is None:
            return EBADF
        if entry["kind"] == "file":
            st = entry["stat"]
            packed = pack_filestat(len(entry["buf"]), st.mtime_ns if st else 0,
                                   FT_REG, self._ino(entry["path"]))
        elif entry["kind"] == "dir":
            st = self._fs.stat(entry["path"])
            packed = pack_filestat(st.size, st.mtime_ns, FT_DIR,
                                   self._ino(entry["path"]))
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
        entry = self._fds.get(fd)
        if entry is None or entry["kind"] != "file":
            return EBADF
        if not entry["writable"]:
            return EBADF
        buf = entry["buf"]
        if size < len(buf):
            del buf[size:]
        else:
            buf += b"\0" * (size - len(buf))
        entry["dirty"] = True
        return OK

    # -- readdir ----------------------------------------------------------

    def fd_readdir(self, caller: "wasmtime.Caller", fd: int, buf: int,
                   buf_len: int, cookie: int, used: int) -> int:
        entry = self._fds.get(fd)
        if entry is None or entry["kind"] != "dir":
            return EBADF
        if entry["dirents"] is None:
            entry["dirents"] = self._fs.readdir(entry["path"])
        out = bytearray()
        i = cookie
        while i < len(entry["dirents"]) and len(out) < buf_len:
            name, filetype = entry["dirents"][i]
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


def _spec() -> dict[str, tuple[list, list]]:
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
