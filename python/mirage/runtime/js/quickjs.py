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

from mirage.runtime.js.base import JsRunArgs, JsRunResult, JsRuntime
from mirage.runtime.wasm import WasmRuntime

QUICKJS_HOME_ENV = "MIRAGE_QUICKJS_HOME"

_WASM_NAME = "qjs-wasi.wasm"

_BUILD_HINT = (
    f"the quickjs runtime needs a {_WASM_NAME} module: download a WASI "
    "build of quickjs-ng from "
    "https://github.com/quickjs-ng/quickjs/releases, and point the yaml "
    "`runtime: quickjs: home:` key, the Workspace `runtime_options` "
    f"argument, or the {QUICKJS_HOME_ENV} environment variable at the "
    "directory containing it")


class QuickJsRuntime(JsRuntime):
    """Run JavaScript on a WASI quickjs-ng under wasmtime, in-process.

    A bare modern JS engine (ES2023 syntax, ES modules, `JSON`, regex,
    `Promise`, top-level await) inside a wasm sandbox: no node builtins,
    no `require`, no npm, no network. The `std`/`os` globals are exposed
    (quickjs-ng `--std`), so scripts read stdin with
    `std.in.readAsString()`. Code does not see workspace mounts; the
    `node`/`js` command resolves script files through the workspace
    before the run, but file I/O inside the code cannot reach mounts.

    Each run gets its own epoch-interruption engine (via the shared
    wasm runtime), so a cancelled run traps it and reclaims the
    thread; a safeguard timeout stops the engine instead of leaking it.

    The module comes from the `home` argument (the yaml
    `runtime: quickjs: home:` entry ends up here) or the
    MIRAGE_QUICKJS_HOME environment variable.

    Args:
        home (str | None): directory containing qjs-wasi.wasm. None
            reads MIRAGE_QUICKJS_HOME.
    """

    name = "quickjs"

    def __init__(self, home: str | None = None) -> None:
        if wasmtime is None:
            raise ImportError(
                "the quickjs runtime requires the 'quickjs' extra. Install "
                "with: pip install mirage-ai[quickjs], or select another "
                "runtime")
        root = home or os.environ.get(QUICKJS_HOME_ENV)
        if not root:
            raise FileNotFoundError(_BUILD_HINT)
        self._wasm = Path(root) / _WASM_NAME
        if not self._wasm.is_file():
            raise FileNotFoundError(
                f"no {_WASM_NAME} under {root}; {_BUILD_HINT}")
        self._runtime = WasmRuntime(self._wasm, "js")

    async def run(self, args: JsRunArgs) -> JsRunResult:
        # --std exposes the std/os globals (stdin via std.in); -m selects
        # ES-module mode for .mjs sources. Trailing args become scriptArgs.
        argv = ["qjs", "--std"]
        if args.module:
            argv.append("-m")
        argv += ["-e", args.code, *args.args]
        stdout, stderr, exit_code = await self._runtime.run(
            argv=argv,
            stdin=args.stdin,
            env=list(args.env.items()),
            preopens=[],
        )
        return JsRunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)
