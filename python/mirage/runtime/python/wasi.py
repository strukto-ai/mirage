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
import os
import tempfile
from pathlib import Path

try:
    import wasmtime
except ImportError:
    wasmtime = None  # type: ignore[assignment]

from mirage.runtime.python.base import (PythonRunArgs, PythonRunResult,
                                        PythonRuntime)

logger = logging.getLogger(__name__)

WASI_PYTHON_ENV = "MIRAGE_WASI_PYTHON"

_BUILD_HINT = (
    "the wasi runtime needs a CPython WASI build directory (python.wasm "
    "plus lib/): download one from "
    "https://github.com/brettcannon/cpython-wasi-build/releases, unzip it, "
    f"and point the {WASI_PYTHON_ENV} environment variable (or the "
    "runtime's python_wasm argument) at the directory")


class WasiRuntime(PythonRuntime):
    """Run Python code on a WASI CPython under wasmtime, in-process.

    Full CPython (classes, complete stdlib, real `sys`) inside a wasm
    sandbox: the guest sees only the interpreter's own build directory,
    no host filesystem, no network, and only the environment the run
    passes. Code does not see workspace mounts either; the `python3`
    command still resolves script files through the workspace before the
    run, but file I/O inside the code cannot reach mounts. Use the
    `monty` runtime for workspace file I/O.

    The build directory comes from the `python_wasm` argument or the
    MIRAGE_WASI_PYTHON environment variable. CPython requires the
    preopen to be rights-complete, so the directory is mounted
    read-write into the guest; make it read-only on the host filesystem
    to keep runs from persisting files into the bundle.

    Args:
        python_wasm (str | None): path to the unzipped CPython WASI
            build directory. None reads MIRAGE_WASI_PYTHON.
    """

    name = "wasi"

    def __init__(self, python_wasm: str | None = None) -> None:
        if wasmtime is None:
            raise ImportError(
                "the wasi runtime requires the 'wasi' extra. Install with: "
                "pip install mirage-ai[wasi], or select another runtime")
        root = python_wasm or os.environ.get(WASI_PYTHON_ENV)
        if not root:
            raise FileNotFoundError(_BUILD_HINT)
        self._root = Path(root)
        if not (self._root / "python.wasm").is_file():
            raise FileNotFoundError(
                f"no python.wasm under {self._root}; {_BUILD_HINT}")
        stdlibs = sorted((self._root / "lib").glob("python3.*"))
        if not stdlibs:
            raise FileNotFoundError(
                f"no lib/python3.* under {self._root}; {_BUILD_HINT}")
        self._pythonhome = f"/lib/{stdlibs[-1].name}"
        self._engine = wasmtime.Engine()
        self._module: "wasmtime.Module | None" = None

    def _ensure_module(self) -> "wasmtime.Module":
        """Compile python.wasm once, caching the compilation on disk.

        The precompiled artifact (python.cwasm next to python.wasm)
        deserializes in milliseconds versus a fresh compile; a stale or
        unwritable cache falls back to compiling in memory.
        """
        if self._module is not None:
            return self._module
        wasm = self._root / "python.wasm"
        cache = self._root / "python.cwasm"
        if cache.is_file() and cache.stat().st_mtime >= wasm.stat().st_mtime:
            try:
                self._module = wasmtime.Module.deserialize_file(
                    self._engine, str(cache))
                return self._module
            except wasmtime.WasmtimeError as exc:
                logger.debug("stale python.cwasm cache, recompiling: %s", exc)
        self._module = wasmtime.Module.from_file(self._engine, str(wasm))
        try:
            cache.write_bytes(self._module.serialize())
        except OSError as exc:
            logger.debug("cannot write python.cwasm cache: %s", exc)
        return self._module

    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        return await asyncio.to_thread(self._run_sync, args)

    def _run_sync(self, args: PythonRunArgs) -> PythonRunResult:
        module = self._ensure_module()
        linker = wasmtime.Linker(self._engine)
        linker.define_wasi()
        store = wasmtime.Store(self._engine)
        wasi = wasmtime.WasiConfig()
        # sys.argv becomes ['-c', *args.args], matching the local runtime.
        wasi.argv = ["python", "-c", args.code, *args.args]
        with tempfile.TemporaryDirectory(prefix="mirage-wasi-") as td:
            stdin_path = f"{td}/stdin"
            stdout_path = f"{td}/stdout"
            stderr_path = f"{td}/stderr"
            Path(stdin_path).write_bytes(args.stdin or b"")
            wasi.stdin_file = stdin_path
            wasi.stdout_file = stdout_path
            wasi.stderr_file = stderr_path
            wasi.preopen_dir(str(self._root), "/")
            wasi.env = [
                *args.env.items(),
                ("PYTHONHOME", self._pythonhome),
                ("PYTHONPATH", self._pythonhome),
            ]
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
                trap_message = f"python3: wasm trap: {exc.message}\n".encode()
            stdout = Path(stdout_path).read_bytes()
            stderr = Path(stderr_path).read_bytes() + trap_message
        return PythonRunResult(stdout=stdout,
                               stderr=stderr or None,
                               exit_code=exit_code)
