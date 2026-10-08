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
import threading
from pathlib import Path
from unittest.mock import Mock

import pytest

from mirage.runtime.files import RuntimeFiles
from mirage.runtime.wasm.execution import WasmExecution
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
    fs = WasmView(core=bridge)
    execution = WasmExecution(Path("unused.wasm"), "probe")
    engine = Mock()

    def worker(*args):
        try:
            bridge.call("write", "/probe", data=b"x")
            return b"", None, 0
        finally:
            worker_finished.set()

    monkeypatch.setattr(execution, "_ensure_serialized", lambda: b"")
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
