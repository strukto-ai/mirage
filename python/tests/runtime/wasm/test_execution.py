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
import os
import threading
from pathlib import Path
from unittest.mock import Mock

import pytest

from mirage.runtime.files import RuntimeFiles
from mirage.runtime.wasm.errors import ENOENT
from mirage.runtime.wasm.execution import WasmExecution
from mirage.runtime.wasm.fs import WasiFs
from mirage.runtime.wasm.view import WasmView


@pytest.mark.asyncio
async def test_cancel_joins_worker_and_host_operation(monkeypatch):
    entered, cleanup, release = (asyncio.Event() for _ in range(3))
    worker_finished = threading.Event()
    writes = []

    async def dispatch(op, path, **kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
            writes.append(op)
        finally:
            cleanup.set()
            await release.wait()
        return None, None

    bridge = RuntimeFiles(dispatch, asyncio.get_running_loop())
    fs = WasmView(files=bridge)
    execution = WasmExecution(Path("unused.wasm"), "probe")
    engine = Mock()

    def worker(*args):
        try:
            bridge.call("write", "/probe", data=b"x")
            return b"", None, 0
        finally:
            worker_finished.set()

    monkeypatch.setattr(execution, "_checkout", lambda: (engine, None))
    monkeypatch.setattr(execution, "_run_sync", worker)
    monkeypatch.setattr(
        "mirage.runtime.wasm.execution.epoch_engine", lambda: engine
    )
    task = asyncio.create_task(execution.run([], None, [], fs))
    await entered.wait()
    task.cancel()
    await cleanup.wait()
    assert not task.done()
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker_finished.is_set()
    assert not bridge._pending
    assert writes == []
    engine.increment_epoch.assert_called_once()


@pytest.mark.asyncio
async def test_cancel_before_wasm_store_is_ready_does_not_miss_epoch(
    tmp_path, monkeypatch
):
    wasmtime = pytest.importorskip("wasmtime")
    module = tmp_path / "spin.wasm"
    module.write_bytes(
        wasmtime.wat2wasm(
            '(module (func (export "_start") (loop $spin (br $spin))))'
        )
    )
    execution = WasmExecution(module, "probe")
    original = execution._run_sync
    entered, release, finished = (threading.Event() for _ in range(3))

    def worker(*args):
        entered.set()
        assert release.wait(5)
        try:
            return original(*args)
        finally:
            finished.set()

    monkeypatch.setattr(execution, "_run_sync", worker)
    task = asyncio.create_task(execution.run([], None, [], WasmView()))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        task.cancel()
        await asyncio.sleep(0)
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert finished.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code, expected", [(0, 0), (130, 130), (200, 200), (256, 0), (-1, 255)]
)
async def test_guest_exit_status_keeps_output(tmp_path, code, expected):
    wasmtime = pytest.importorskip("wasmtime")
    module = tmp_path / "exit.wasm"
    module.write_bytes(
        wasmtime.wat2wasm(f"""(module
      (import "wasi_snapshot_preview1" "fd_write"
        (func $write (param i32 i32 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
      (memory (export "memory") 1)
      (data (i32.const 32) "kept")
      (func (export "_start")
        (i32.store (i32.const 0) (i32.const 32))
        (i32.store (i32.const 4) (i32.const 4))
        (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
        (call $exit (i32.const {code}))))""")
    )
    execution = WasmExecution(module, "probe")
    assert await execution.run([], None, [], WasmView()) == (
        b"kept",
        None,
        expected,
    )
    assert await execution.run([], None, [], WasmView()) == (
        b"kept",
        None,
        expected,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("absolute", [False, True])
async def test_cancel_interrupts_poll_clock_and_reuses_engine(
    tmp_path, monkeypatch, absolute
):
    wasmtime = pytest.importorskip("wasmtime")
    clock_setup = ""
    if absolute:
        clock_setup = """
        (drop (call $clock (i32.const 1) (i64.const 0) (i32.const 24)))
        (i64.store (i32.const 24)
          (i64.add (i64.load (i32.const 24)) (i64.const 30000000000)))
        (i32.store (i32.const 40) (i32.const 1))"""
    module = tmp_path / "sleep.wasm"
    module.write_bytes(
        wasmtime.wat2wasm(f"""(module
      (import "wasi_snapshot_preview1" "clock_time_get"
        (func $clock (param i32 i64 i32) (result i32)))
      (import "wasi_snapshot_preview1" "poll_oneoff"
        (func $poll (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "_start")
        (i32.store (i32.const 16) (i32.const 1))
        (i64.store (i32.const 24) (i64.const 30000000000))
        {clock_setup}
        (drop (call $poll
          (i32.const 0) (i32.const 64) (i32.const 1) (i32.const 96)))))""")
    )
    entered = threading.Event()
    original = WasiFs.poll_oneoff

    def poll(self, *args):
        entered.set()
        return original(self, *args)

    monkeypatch.setattr(WasiFs, "poll_oneoff", poll)
    execution = WasmExecution(module, "probe")
    for _ in range(2):
        entered.clear()
        task = asyncio.create_task(execution.run([], None, [], WasmView()))
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
    assert len(execution._idle) == 1


@pytest.mark.asyncio
async def test_close_releases_pooled_native_modules(tmp_path):
    wasmtime = pytest.importorskip("wasmtime")
    module = tmp_path / "empty.wasm"
    module.write_bytes(wasmtime.wat2wasm('(module (func (export "_start")))'))
    execution = WasmExecution(module, "probe")
    await execution.run([], None, [], WasmView())
    assert len(execution._idle) == 1
    engine, compiled = execution._idle[0]
    await execution.close()
    assert execution._idle == []
    with pytest.raises(ValueError, match="closed"):
        compiled.ptr()
    with pytest.raises(ValueError, match="closed"):
        engine.ptr()


@pytest.mark.asyncio
async def test_a_torn_cache_is_compiled_again_and_replaced_whole(tmp_path):
    wasmtime = pytest.importorskip("wasmtime")
    module = tmp_path / "empty.wasm"
    module.write_bytes(wasmtime.wat2wasm('(module (func (export "_start")))'))
    first = WasmExecution(module, "probe")
    await first.run([], None, [], WasmView())
    await first.close()
    cache = tmp_path / "empty.cwasm"
    whole = cache.read_bytes()
    cache.write_bytes(whole[: len(whole) // 2])
    again = WasmExecution(module, "probe")
    assert await again.run([], None, [], WasmView()) == (b"", None, 0)
    await again.close()
    assert cache.read_bytes() == whole
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "empty.cwasm",
        "empty.wasm",
    ]


@pytest.mark.asyncio
async def test_a_new_cache_is_synced_before_it_takes_its_name(
    tmp_path, monkeypatch
):
    wasmtime = pytest.importorskip("wasmtime")
    module = tmp_path / "empty.wasm"
    module.write_bytes(wasmtime.wat2wasm('(module (func (export "_start")))'))
    events: list[str] = []
    fsync, replace = os.fsync, os.replace

    def synced(fd: int) -> None:
        events.append("fsync")
        fsync(fd)

    def renamed(src: str, dst: str) -> None:
        events.append(f"replace {Path(dst).name}")
        replace(src, dst)

    monkeypatch.setattr(os, "fsync", synced)
    monkeypatch.setattr(os, "replace", renamed)
    execution = WasmExecution(module, "probe")
    await execution.run([], None, [], WasmView())
    await execution.close()
    assert events == ["fsync", "replace empty.cwasm"]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["checkout", "worker"])
@pytest.mark.parametrize("cancel", [False, True])
async def test_close_releases_late_engines(monkeypatch, phase, cancel):
    execution = WasmExecution(Path("unused.wasm"), "probe")
    engine, module = Mock(), Mock()
    entered, release = threading.Event(), threading.Event()

    def checkout():
        if phase == "checkout":
            entered.set()
            assert release.wait(5)
        return engine, module

    def worker(*args):
        if phase == "worker":
            entered.set()
            assert release.wait(5)
        return b"", None, 0

    monkeypatch.setattr(execution, "_checkout", checkout)
    monkeypatch.setattr(execution, "_run_sync", worker)
    task = asyncio.create_task(execution.run([], None, [], WasmView()))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        if cancel:
            task.cancel()
            await asyncio.sleep(0)
        await execution.close()
        module.close.assert_not_called()
        engine.close.assert_not_called()
    finally:
        release.set()
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
    else:
        assert await asyncio.wait_for(task, 5) == (b"", None, 0)
    assert execution._idle == []
    module.close.assert_called_once()
    engine.close.assert_called_once()
    await execution.close()
    module.close.assert_called_once()


@pytest.mark.asyncio
async def test_closed_execution_refuses_new_runs():
    execution = WasmExecution(Path("unused.wasm"), "probe")
    await execution.close()
    with pytest.raises(RuntimeError, match="closed"):
        await execution.run([], None, [], WasmView())


@pytest.mark.asyncio
async def test_guest_cannot_open_host_file_above_build_root(tmp_path):
    wasmtime = pytest.importorskip("wasmtime")
    root = tmp_path / "build"
    root.mkdir()
    (tmp_path / "secret").write_bytes(b"host secret")
    module = tmp_path / "open.wasm"
    module.write_bytes(
        wasmtime.wat2wasm("""(module
      (import "wasi_snapshot_preview1" "path_open"
        (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "../secret")
      (func (export "_start")
        (call $exit (call $open
          (i32.const 3) (i32.const 1) (i32.const 0) (i32.const 9)
          (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 32)))))""")
    )
    execution = WasmExecution(module, "probe")
    try:
        assert await execution.run(
            ["probe"], None, [], WasmView(str(root))
        ) == (
            b"",
            None,
            ENOENT,
        )
    finally:
        await execution.close()
