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
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Callable, ClassVar

from mirage.runtime.config import HomeConfig, RuntimeConfig
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.bootstrap import bootstrap
from mirage.runtime.python.flags import init_argv
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import (DispatchFn, RunArgs, RunResult, RuntimeReach,
                                  ScriptSource)
from mirage.runtime.vfs import RuntimeVFS
from mirage.runtime.wasm import WasmFsConfig, WasmRuntime, WasmVFS

wasmtime: Any
try:
    import wasmtime as _wasmtime
except ImportError:
    wasmtime = None
else:
    wasmtime = _wasmtime

WASI_HOME_ENV = "MIRAGE_WASI_HOME"

_BUILD_HINT = (
    "the wasi runtime needs a CPython WASI build directory (python.wasm "
    "plus lib/): download one from "
    "https://github.com/brettcannon/cpython-wasi-build/releases, unzip it, "
    "and point the runtime entry's config `home` (yaml `runtimes: [{name: "
    f"wasi, config: {{home: ...}}}}]`) or the {WASI_HOME_ENV} environment "
    "variable at the directory")


class WasiRuntime(PythonRuntime):
    """Run Python code on a WASI CPython under wasmtime, in-process.

    Full CPython (classes, complete stdlib, real `sys`) inside a wasm
    sandbox: no host filesystem, no network, only the environment the
    run passes. The guest's filesystem imports are intercepted, so
    `open('/data/f.txt')` inside the code routes through the workspace
    dispatch — the same cache, write modes, and session narrowing as
    shell commands — while the interpreter's own build directory is
    served read-only from the host. Workspace mounts are therefore
    visible to the code with no FUSE mount and no extra setup; without
    an injected dispatch, only the build directory is visible.

    Runs execute on a worker thread with the GIL released, and each run
    gets its own epoch-interruption engine: cancelling the `run` task
    bumps the epoch, which traps the run and reclaims the thread, so a
    limit timeout stops the interpreter instead of leaking it.

    The build directory comes from the config `home` (the yaml entry's
    ``config`` block ends up here) or the MIRAGE_WASI_HOME environment
    variable. It is read-only inside the sandbox; guest writes land in
    the workspace or answer EACCES, never in the bundle.
    """

    name = "wasi"
    # Guest file I/O can only travel the workspace bridge; the one
    # host surface is the interpreter's own build directory, served
    # read-only (mutations raise PermissionError in WasmVFS), so
    # nothing goes around the gate.
    reach: RuntimeReach = "vfs"

    config_cls: ClassVar[type[RuntimeConfig]] = HomeConfig
    config: HomeConfig

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: HomeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        if wasmtime is None:
            raise ImportError(
                "the wasi runtime requires the 'wasi' extra. Install with: "
                "pip install mirage-ai[wasi], or select another runtime")
        super().__init__(captures, config, script)
        root = self.config.home or os.environ.get(WASI_HOME_ENV)
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
        self._dispatch: DispatchFn | None = None
        self._resolver: MountResolver | None = None
        self._runtime = WasmRuntime(self._root / "python.wasm", "python3")

    def attach(self, dispatch: DispatchFn, resolver: MountResolver) -> None:
        if self._dispatch is None:
            self._dispatch = dispatch
            self._resolver = resolver

    async def run(self, args: RunArgs) -> RunResult:
        # Mount prefixes route to the workspace bridge; everything else
        # is served from the build directory, so a mount at "/" never
        # collides with the interpreter's own files.
        core = (RuntimeVFS(self._dispatch, asyncio.get_running_loop(),
                           self._resolver)
                if self._dispatch is not None else None)
        fs = WasmVFS(WasmFsConfig(host_root=str(self._root)), core)
        # sys.argv becomes [prog, *args.args], matching the local runtime.
        stdout, stderr, exit_code = await self._runtime.run(
            argv=[
                "python", *init_argv(args.flags), "-c",
                bootstrap(args.code, args.prog), *args.args
            ],
            stdin=args.stdin,
            env=[
                *args.env.items(),
                ("PYTHONHOME", self._pythonhome),
                ("PYTHONPATH", self._pythonhome),
                ("PYTHONDONTWRITEBYTECODE", "1"),
            ],
            fs=fs,
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)
