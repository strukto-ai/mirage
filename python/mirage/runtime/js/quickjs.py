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

from mirage.runtime.base import Runtime
from mirage.runtime.config import HomeConfig, RuntimeConfig
from mirage.runtime.types import RunArgs, RunResult, ScriptSource
from mirage.runtime.wasm import GuestFs, SyncDispatch, WasmRuntime

wasmtime: Any
try:
    import wasmtime as _wasmtime
except ImportError:
    wasmtime = None
else:
    wasmtime = _wasmtime

QUICKJS_HOME_ENV = "MIRAGE_QUICKJS_HOME"

_WASM_NAME = "qjs-wasi.wasm"

_BUILD_HINT = (
    f"the quickjs runtime needs a {_WASM_NAME} module: download a WASI "
    "build of quickjs-ng from "
    "https://github.com/quickjs-ng/quickjs/releases, and point the runtime "
    "entry's config `home` (yaml `runtimes: [{name: quickjs, config: "
    f"{{home: ...}}}}]`) or the {QUICKJS_HOME_ENV} environment variable at "
    "the directory containing it")


class QuickJsRuntime(Runtime):
    """Run JavaScript on a WASI quickjs-ng under wasmtime, in-process.

    A bare modern JS engine (ES2023 syntax, ES modules, `JSON`, regex,
    `Promise`, top-level await) inside a wasm sandbox: no node builtins,
    no `require`, no npm, no network. The `std`/`os` globals are exposed
    (quickjs-ng `--std`), so scripts read stdin with
    `std.in.readAsString()` and reach files with `std.open`/`os.readdir`.
    The engine's filesystem imports are intercepted, so that file I/O
    routes through the workspace dispatch — the same cache, write modes,
    and session narrowing as shell commands — with no FUSE mount and no
    extra setup. Without an injected dispatch the run sees an empty
    filesystem; the `node`/`js` command resolves script files through
    the workspace before the run either way.

    Each run gets its own epoch-interruption engine (via the shared
    wasm runtime), so a cancelled run traps it and reclaims the
    thread; a safeguard timeout stops the engine instead of leaking it.

    The module comes from the config `home` (the yaml entry's
    ``config`` block ends up here) or the MIRAGE_QUICKJS_HOME
    environment variable.
    """

    name = "quickjs"
    captures = ("node", "js")

    config_cls: ClassVar[type[RuntimeConfig]] = HomeConfig
    config: HomeConfig

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: HomeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        if wasmtime is None:
            raise ImportError(
                "the quickjs runtime requires the 'quickjs' extra. Install "
                "with: pip install mirage-ai[quickjs], or select another "
                "runtime")
        super().__init__(captures, config, script)
        root = self.config.home or os.environ.get(QUICKJS_HOME_ENV)
        if not root:
            raise FileNotFoundError(_BUILD_HINT)
        self._wasm = Path(root) / _WASM_NAME
        if not self._wasm.is_file():
            raise FileNotFoundError(
                f"no {_WASM_NAME} under {root}; {_BUILD_HINT}")
        self._dispatch: Callable[..., Any] | None = None
        self._mount_prefixes: Callable[[], list[str]] | None = None
        self._runtime = WasmRuntime(self._wasm, "js")

    def attach(self, dispatch: Callable[..., Any],
               mount_prefixes: Callable[[], list[str]]) -> None:
        if self._dispatch is None:
            self._dispatch = dispatch
            self._mount_prefixes = mount_prefixes

    async def run(self, args: RunArgs) -> RunResult:
        # --std exposes the std/os globals (stdin via std.in); -m selects
        # ES-module mode for .mjs sources. Trailing args become scriptArgs.
        argv = ["qjs", "--std"]
        if args.flags.get("module"):
            argv.append("-m")
        argv += ["-e", args.code, *args.args]
        bridge = (SyncDispatch(self._dispatch, asyncio.get_running_loop())
                  if self._dispatch is not None else None)
        fs = GuestFs(bridge=bridge, mount_prefixes=self._mount_prefixes)
        stdout, stderr, exit_code = await self._runtime.run(
            argv=argv,
            stdin=args.stdin,
            env=list(args.env.items()),
            fs=fs,
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)
