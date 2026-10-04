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
import logging
import threading
from pathlib import Path
from typing import Any

from mirage.concurrency.limiter import settle
from mirage.runtime.wasm.fs import WasiFs, install_wasi_fs
from mirage.runtime.wasm.loader import wasmtime
from mirage.runtime.wasm.view import WasmView

logger = logging.getLogger(__name__)


def epoch_engine() -> "wasmtime.Engine":
    """Build an engine with epoch interruption so runs can be trapped."""
    config = wasmtime.Config()
    config.epoch_interruption = True
    # POSIX-signal traps, not Mach ports: the task-wide Mach exception
    # ports wasmtime claims on macOS stop composing once another native
    # runtime in the same process touches exception handling (seen with
    # pydantic-monty >= 0.0.20 worker pools), after which wasmtime's
    # handler thread kills the process outright with `mach_msg failed
    # with 268451845 (10004005)`. Signal-based traps coexist; the flag
    # is a no-op off macOS.
    config.macos_use_mach_ports = False
    return wasmtime.Engine(config)


async def _join_cancelled(task: asyncio.Task[Any]) -> None:
    """Join owned work while preserving the caller's original cancellation."""
    try:
        await settle(task)
    except Exception:
        logger.debug("WASM cleanup failed", exc_info=True)


class WasmExecution:
    """Compile-once, run-many WASI module under wasmtime, in-process.

    Shared machinery for the WASI-based runtimes (`wasi` CPython,
    `quickjs` JavaScript): compile the module once and cache the
    compilation on disk next to the `.wasm`, then run each request on a
    worker thread with its own epoch-interruption engine so a cancelled
    run traps the module and reclaims the thread. Per-run engines keep an
    epoch bump from reaching concurrent runs.

    Filesystem imports are intercepted: every fd_*/path_* call the guest
    makes lands in WasiFs host functions backed by the caller's WasmView
    router, so the run sees exactly what the router serves (interpreter
    build read-only, workspace mounts through dispatch) — no host
    filesystem, no network, only the passed environment.

    Args:
        wasm_path (Path): the `.wasm` module to run.
        trap_prefix (str): command name prefixing a wasm-trap stderr line.
    """

    def __init__(self, wasm_path: Path, trap_prefix: str) -> None:
        self._wasm = Path(wasm_path)
        self._cache = self._wasm.with_suffix(".cwasm")
        self._trap_prefix = trap_prefix
        self._compile_lock = threading.Lock()
        self._serialized: bytes | None = None

    def _ensure_serialized(self) -> bytes:
        """Compile the module once, caching the compilation on disk.

        The precompiled artifact (`<name>.cwasm` next to the `.wasm`)
        deserializes in milliseconds versus a fresh compile. Epoch
        checks are compiled in, so a cache produced with different
        engine settings fails deserialization and is recompiled; an
        unwritable directory just skips the disk cache.
        """
        with self._compile_lock:
            if self._serialized is not None:
                return self._serialized
            engine = epoch_engine()
            if (
                self._cache.is_file()
                and self._cache.stat().st_mtime >= self._wasm.stat().st_mtime
            ):
                try:
                    wasmtime.Module.deserialize_file(engine, str(self._cache))
                    cached = self._cache.read_bytes()
                    self._serialized = cached
                    return cached
                except wasmtime.WasmtimeError as exc:
                    logger.debug(
                        "stale %s cache, recompiling: %s",
                        self._cache.name,
                        exc,
                    )
            module = wasmtime.Module.from_file(engine, str(self._wasm))
            serialized = bytes(module.serialize())
            self._serialized = serialized
            try:
                self._cache.write_bytes(serialized)
            except OSError as exc:
                logger.debug(
                    "cannot write %s cache: %s", self._cache.name, exc
                )
            return serialized

    async def run(
        self,
        argv: list[str],
        stdin: bytes | None,
        env: list[tuple[str, str]],
        fs: WasmView,
    ) -> tuple[bytes, bytes | None, int]:
        """Run the module once and return (stdout, stderr, exit_code).

        Args:
            argv (list[str]): full argv, including the program name.
            stdin (bytes | None): bytes fed to the run's stdin.
            env (list[tuple[str, str]]): environment as (name, value) pairs.
            fs (WasmView): path router serving the run's filesystem.
        """
        compilation = asyncio.create_task(
            asyncio.to_thread(self._ensure_serialized)
        )
        try:
            serialized = await asyncio.shield(compilation)
        except asyncio.CancelledError:
            await _join_cancelled(compilation)
            raise
        engine = epoch_engine()
        canceled = threading.Event()
        worker = asyncio.create_task(
            asyncio.to_thread(
                self._run_sync,
                engine,
                serialized,
                argv,
                stdin,
                env,
                fs,
                canceled,
            )
        )
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            canceled.set()
            engine.increment_epoch()

            async def stop() -> None:
                try:
                    await fs.abort()
                finally:
                    await worker

            await _join_cancelled(asyncio.create_task(stop()))
            raise

    def _run_sync(
        self,
        engine: "wasmtime.Engine",
        serialized: bytes,
        argv: list[str],
        stdin: bytes | None,
        env: list[tuple[str, str]],
        fs: WasmView,
        canceled: threading.Event,
    ) -> tuple[bytes, bytes | None, int]:
        module = wasmtime.Module.deserialize(engine, serialized)
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        store = wasmtime.Store(engine)
        store.set_epoch_deadline(1)
        if canceled.is_set():
            return b"", None, 130
        wasi_fs = WasiFs(fs, stdin or b"")
        install_wasi_fs(linker, store, wasi_fs)
        wasi = wasmtime.WasiConfig()
        wasi.argv = argv
        wasi.env = list(env)
        store.set_wasi(wasi)
        instance = linker.instantiate(store, module)
        start = instance.exports(store)["_start"]
        if not isinstance(start, wasmtime.Func):
            raise RuntimeError("WASI module exports a non-function _start")
        exit_code = 0
        trap_message = b""
        try:
            start(store)
        except wasmtime.ExitTrap as exc:
            exit_code = exc.code
        except wasmtime.Trap as exc:
            exit_code = 1
            msg = f"{self._trap_prefix}: wasm trap: {exc.message}\n"
            trap_message = msg.encode()
        lost = wasi_fs.close_all()
        if lost:
            trap_message += "".join(
                f"{self._trap_prefix}: {line}\n" for line in lost
            ).encode()
            exit_code = exit_code or 1
        stdout = bytes(wasi_fs.stdout)
        stderr = bytes(wasi_fs.stderr) + trap_message
        return stdout, stderr or None, exit_code
