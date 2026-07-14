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
import tempfile
import threading
from pathlib import Path

try:
    import wasmtime
except ImportError:
    wasmtime = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


def epoch_engine() -> "wasmtime.Engine":
    """Build an engine with epoch interruption so runs can be trapped."""
    config = wasmtime.Config()
    config.epoch_interruption = True
    return wasmtime.Engine(config)


class WasmRuntime:
    """Compile-once, run-many WASI module under wasmtime, in-process.

    Shared machinery for the WASI-based runtimes (`wasi` CPython,
    `quickjs` JavaScript): compile the module once and cache the
    compilation on disk next to the `.wasm`, then run each request on a
    worker thread with its own epoch-interruption engine so a cancelled
    run traps the module and reclaims the thread. Per-run engines keep an
    epoch bump from reaching concurrent runs.

    The run sees only the directories the caller preopens: no host
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
            if (self._cache.is_file() and self._cache.stat().st_mtime
                    >= self._wasm.stat().st_mtime):
                try:
                    wasmtime.Module.deserialize_file(engine, str(self._cache))
                    cached = self._cache.read_bytes()
                    self._serialized = cached
                    return cached
                except wasmtime.WasmtimeError as exc:
                    logger.debug("stale %s cache, recompiling: %s",
                                 self._cache.name, exc)
            module = wasmtime.Module.from_file(engine, str(self._wasm))
            serialized = bytes(module.serialize())
            self._serialized = serialized
            try:
                self._cache.write_bytes(serialized)
            except OSError as exc:
                logger.debug("cannot write %s cache: %s", self._cache.name,
                             exc)
            return serialized

    async def run(
        self,
        argv: list[str],
        stdin: bytes | None,
        env: list[tuple[str, str]],
        preopens: list[tuple[str, str]],
    ) -> tuple[bytes, bytes | None, int]:
        """Run the module once and return (stdout, stderr, exit_code).

        Args:
            argv (list[str]): full argv, including the program name.
            stdin (bytes | None): bytes fed to the run's stdin.
            env (list[tuple[str, str]]): environment as (name, value) pairs.
            preopens (list[tuple[str, str]]): (host_dir, sandbox_path) dirs
                exposed to the run's filesystem.
        """
        serialized = await asyncio.to_thread(self._ensure_serialized)
        engine = epoch_engine()
        try:
            return await asyncio.to_thread(self._run_sync, engine, serialized,
                                           argv, stdin, env, preopens)
        except asyncio.CancelledError:
            # The worker thread is still inside the run; bumping the
            # epoch trips the store's deadline, traps it, and lets the
            # thread exit.
            engine.increment_epoch()
            raise

    def _run_sync(
        self,
        engine: "wasmtime.Engine",
        serialized: bytes,
        argv: list[str],
        stdin: bytes | None,
        env: list[tuple[str, str]],
        preopens: list[tuple[str, str]],
    ) -> tuple[bytes, bytes | None, int]:
        module = wasmtime.Module.deserialize(engine, serialized)
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        store = wasmtime.Store(engine)
        store.set_epoch_deadline(1)
        wasi = wasmtime.WasiConfig()
        wasi.argv = argv
        with tempfile.TemporaryDirectory(prefix="mirage-wasm-") as td:
            stdin_path = f"{td}/stdin"
            stdout_path = f"{td}/stdout"
            stderr_path = f"{td}/stderr"
            Path(stdin_path).write_bytes(stdin or b"")
            wasi.stdin_file = stdin_path
            wasi.stdout_file = stdout_path
            wasi.stderr_file = stderr_path
            for host, dest in preopens:
                wasi.preopen_dir(str(host), dest)
            wasi.env = list(env)
            store.set_wasi(wasi)
            instance = linker.instantiate(store, module)
            start = instance.exports(store)["_start"]
            exit_code = 0
            trap_message = b""
            try:
                start(store)  # type: ignore[operator]
            except wasmtime.ExitTrap as exc:
                exit_code = exc.code
            except wasmtime.Trap as exc:
                exit_code = 1
                msg = f"{self._trap_prefix}: wasm trap: {exc.message}\n"
                trap_message = msg.encode()
            stdout = Path(stdout_path).read_bytes()
            stderr = Path(stderr_path).read_bytes() + trap_message
        return stdout, stderr or None, exit_code
