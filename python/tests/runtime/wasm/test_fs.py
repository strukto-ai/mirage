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
import inspect
import struct

import pytest

pytest.importorskip("wasmtime")

import wasmtime

from mirage import MountMode, Workspace
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import FileHandle
from mirage.runtime.wasm import fs
from mirage.runtime.wasm.constants import (
    FST_ATIM,
    FST_ATIM_NOW,
    FST_MTIM,
    FST_MTIM_NOW,
)
from mirage.runtime.wasm.errors import EINVAL, EIO, ENOENT
from mirage.runtime.wasm.execution import epoch_engine
from mirage.runtime.wasm.fs import (
    FdEntry,
    WasiFs,
    _call_guarded,
    _spec,
    _stamp,
    install_wasi_fs,
    unpack_iovs,
)
from mirage.runtime.wasm.view import WasmView
from mirage.utils.stat_view import mtime_ns
from mirage.vfs.ram import RAMVFS

# End-to-end host-function behavior (path_open buffering, fd table,
# errno answers inside a real guest) is covered by the live wasi and
# quickjs batteries; this file guards the ABI table itself.


def test_spec_names_all_resolve_to_methods_with_matching_arity():
    for name, (params, results) in _spec().items():
        method = getattr(WasiFs, name)
        # self + caller + one parameter per wasm value type.
        arity = len(inspect.signature(method).parameters)
        assert arity == len(params) + 2, name
        assert len(results) == 1, name


def test_spec_covers_every_fs_import_of_the_shipped_guests():
    # python.wasm imports 28 preview1 fs functions; qjs-wasi.wasm a
    # 16-function subset. fd_renumber is shadowed too (dup2 support).
    assert len(_spec()) == 29


def _raising(exc):
    """A host function double that fails with `exc`.

    Args:
        exc (BaseException): what the call raises.
    """

    def fn(caller, *args):
        raise exc

    return fn


def test_guarded_call_maps_an_fs_error_to_its_errno():
    assert _call_guarded(_raising(FileNotFoundError("x")), None) == ENOENT
    assert _call_guarded(_raising(ValueError("row too large")), None) == EINVAL


def test_guarded_call_answers_eio_for_an_upstream_failure():
    # One record a remote API refuses must fail the guest's call on it,
    # not trap the whole run the guest could have finished without it.
    upstream = RuntimeError("upstream 502 Bad Gateway")
    assert _call_guarded(_raising(upstream), None) == EIO


def test_stamp_omits_a_field_no_flag_selected():
    # Neither bit set is utimensat's UTIME_OMIT: leave that stamp alone.
    assert _stamp(0, FST_MTIM, FST_MTIM_NOW, 5_000_000_000, 1.0) is None


def test_stamp_reads_the_argument_as_nanoseconds():
    assert (
        _stamp(FST_MTIM, FST_MTIM, FST_MTIM_NOW, 200_000_000_000, 1.0)
        == "1970-01-01T00:03:20+00:00"
    )


def test_stamp_now_wins_over_the_argument():
    # preview1 has both bits, and *_NOW means ignore the value entirely.
    both = FST_ATIM | FST_ATIM_NOW
    assert (
        _stamp(both, FST_ATIM, FST_ATIM_NOW, 200_000_000_000, 100.0)
        == "1970-01-01T00:01:40+00:00"
    )


def test_stamp_reads_only_its_own_half_of_the_flags():
    assert _stamp(FST_ATIM, FST_MTIM, FST_MTIM_NOW, 1, 1.0) is None
    assert _stamp(FST_MTIM, FST_ATIM, FST_ATIM_NOW, 1, 1.0) is None


def test_install_wasi_fs_locks_the_callback_slab_before_its_funcs(monkeypatch):
    engine = epoch_engine()
    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    store = wasmtime.Store(engine)
    order: list[str] = []
    monkeypatch.setattr(fs, "install_slab_lock", lambda: order.append("lock"))
    real_func = fs.Func

    def counting_func(*args, **kwargs):
        order.append("func")
        return real_func(*args, **kwargs)

    monkeypatch.setattr(fs, "Func", counting_func)
    install_wasi_fs(linker, store, WasiFs(WasmView(), b""))
    assert order[0] == "lock"
    assert order.count("lock") == 1
    assert order.count("func") == len(_spec())


def test_unpack_iovs_decodes_pointer_length_pairs():
    raw = struct.pack("<IIII", 16, 128, 4096, 64)
    assert unpack_iovs(raw, 2) == [(16, 128), (4096, 64)]


def _refuse_flush(path, steps):
    raise NotImplementedError("truncate is not supported")


def test_close_all_reports_a_flush_the_mount_cannot_take(monkeypatch):
    view = WasmView()
    monkeypatch.setattr(view, "flush", _refuse_flush)
    wasi_fs = WasiFs(view, b"")
    handle = FileHandle.opened(
        "/data/f.txt", None, size=0, writable=True, append=False
    )
    handle.write(b"kept")
    wasi_fs._fds.add(FdEntry(kind="file", handle=handle, path="/data/f.txt"))
    assert wasi_fs.close_all() == ["/data/f.txt: truncate is not supported"]


def _wasi_over_ram() -> tuple[Workspace, WasiFs, int, FileHandle]:
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    asyncio.run(ws.vfs.write("/data/f.txt", b""))
    wasi_fs = WasiFs(WasmView(files=RuntimeFiles(ws.vfs.dispatch, None)), b"")
    handle = FileHandle.opened(
        "/data/f.txt", None, size=0, writable=True, append=False
    )
    fd = wasi_fs._fds.add(
        FdEntry(kind="file", handle=handle, path="/data/f.txt")
    )
    return ws, wasi_fs, fd, handle


def test_fd_sync_lands_what_a_file_owes_before_its_close():
    ws, wasi_fs, fd, handle = _wasi_over_ram()
    handle.write(b"synced")
    assert wasi_fs.fd_sync(None, fd) == 0
    assert asyncio.run(ws.vfs.read("/data/f.txt")) == b"synced"
    handle.write(b"!")
    assert wasi_fs.fd_close(None, fd) == 0
    assert asyncio.run(ws.vfs.read("/data/f.txt")) == b"synced!"


def test_fd_filestat_set_times_stamps_after_the_writes_land():
    ws, wasi_fs, fd, handle = _wasi_over_ram()
    handle.write(b"body")
    stamp = 981173107 * 1_000_000_000
    assert wasi_fs.fd_filestat_set_times(None, fd, 0, stamp, FST_MTIM) == 0
    assert wasi_fs.fd_close(None, fd) == 0
    assert asyncio.run(ws.vfs.read("/data/f.txt")) == b"body"
    assert mtime_ns(asyncio.run(ws.vfs.stat("/data/f.txt"))) == stamp


def test_set_times_lands_every_fd_on_the_file_first():
    ws, wasi_fs, fd, handle = _wasi_over_ram()
    other = FileHandle.opened(
        "/data/f.txt", None, size=0, writable=True, append=False
    )
    other.write(b"other")
    other_fd = wasi_fs._fds.add(
        FdEntry(kind="file", handle=other, path="/data/f.txt")
    )
    stamp = 981173107 * 1_000_000_000
    assert wasi_fs.fd_filestat_set_times(None, fd, 0, stamp, FST_MTIM) == 0
    assert wasi_fs.fd_close(None, other_fd) == 0
    assert mtime_ns(asyncio.run(ws.vfs.stat("/data/f.txt"))) == stamp
