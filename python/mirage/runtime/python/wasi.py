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

import os
from pathlib import Path

try:
    import wasmtime
except ImportError:
    wasmtime = None  # type: ignore[assignment]

from mirage.runtime.python.base import (PythonRunArgs, PythonRunResult,
                                        PythonRuntime)
from mirage.runtime.wasm import WasmRuntime

WASI_HOME_ENV = "MIRAGE_WASI_HOME"

_BUILD_HINT = (
    "the wasi runtime needs a CPython WASI build directory (python.wasm "
    "plus lib/): download one from "
    "https://github.com/brettcannon/cpython-wasi-build/releases, unzip it, "
    "and point the yaml `runtime: wasi: home:` key, the Workspace "
    f"`runtime_options` argument, or the {WASI_HOME_ENV} environment "
    "variable at the directory")


class WasiRuntime(PythonRuntime):
    """Run Python code on a WASI CPython under wasmtime, in-process.

    Full CPython (classes, complete stdlib, real `sys`) inside a wasm
    sandbox: the run sees only the interpreter's own build directory,
    no host filesystem, no network, and only the environment the run
    passes. Code does not see workspace mounts either; the `python3`
    command still resolves script files through the workspace before the
    run, but file I/O inside the code cannot reach mounts. Use the
    `monty` runtime for workspace file I/O.

    Runs execute on a worker thread with the GIL released, and each run
    gets its own epoch-interruption engine: cancelling the `run` task
    bumps the epoch, which traps the run and reclaims the thread, so a
    safeguard timeout stops the interpreter instead of leaking it.

    The build directory comes from the `home` argument (the yaml
    `runtime: wasi: home:` entry ends up here) or the MIRAGE_WASI_HOME
    environment variable. CPython requires the preopen to be
    rights-complete, so the directory is mounted read-write into the
    sandbox; make it read-only on the host filesystem to keep runs from
    persisting files into the bundle.

    Args:
        home (str | None): path to the unzipped CPython WASI build
            directory. None reads MIRAGE_WASI_HOME.
    """

    name = "wasi"

    def __init__(self, home: str | None = None) -> None:
        if wasmtime is None:
            raise ImportError(
                "the wasi runtime requires the 'wasi' extra. Install with: "
                "pip install mirage-ai[wasi], or select another runtime")
        root = home or os.environ.get(WASI_HOME_ENV)
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
        self._runtime = WasmRuntime(self._root / "python.wasm", "python3")

    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        # sys.argv becomes ['-c', *args.args], matching the local runtime.
        stdout, stderr, exit_code = await self._runtime.run(
            argv=["python", "-c", args.code, *args.args],
            stdin=args.stdin,
            env=[
                *args.env.items(),
                ("PYTHONHOME", self._pythonhome),
                ("PYTHONPATH", self._pythonhome),
            ],
            preopens=[(str(self._root), "/")],
        )
        return PythonRunResult(stdout=stdout,
                               stderr=stderr,
                               exit_code=exit_code)
