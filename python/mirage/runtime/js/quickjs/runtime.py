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

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, ClassVar

from mirage.runtime.binding import RuntimeContext
from mirage.runtime.config import HomeConfig, RuntimeConfig, resolve_home
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.js.quickjs.execution import cwd_preamble
from mirage.runtime.types import (
    FilesystemOperation,
    RunArgs,
    RunResult,
    RuntimeReach,
)
from mirage.runtime.wasm import WasmExecution, WasmView
from mirage.runtime.wasm.loader import wasmtime

QUICKJS_HOME_ENV = "MIRAGE_QUICKJS_HOME"

_WASM_NAME = "qjs-wasi.wasm"

_BUILD_HINT = (
    f"the quickjs runtime needs a {_WASM_NAME} module: download a WASI "
    "build of quickjs-ng from "
    "https://github.com/quickjs-ng/quickjs/releases, and point the runtime "
    "entry's config `home` (yaml `runtimes: [{name: quickjs, config: "
    f"{{home: ...}}}}]`) or the {QUICKJS_HOME_ENV} environment variable at "
    "the directory containing it"
)


class QuickJsRuntime(JsRuntime):
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
    thread; a limit timeout stops the engine instead of leaking it.

    The module comes from the config `home` (the yaml entry's
    ``config`` block ends up here) or the MIRAGE_QUICKJS_HOME
    environment variable.
    """

    name = "quickjs"
    # The engine is a WASI guest whose `std.open`/`os.readdir` suspend
    # into the workspace bridge: guest I/O has no way around the gate.
    reach: RuntimeReach = "workspace"
    filesystem: ClassVar[tuple[FilesystemOperation, ...]] = (
        "read",
        "write",
        "list",
        "stat",
    )

    config_cls: ClassVar[type[RuntimeConfig]] = HomeConfig
    config: HomeConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: HomeConfig | dict[str, Any] | None = None,
    ) -> None:
        if wasmtime is None:
            raise ImportError(
                "the quickjs runtime requires the 'quickjs' extra. Install "
                "with: pip install mirage-ai[quickjs], or select another "
                "runtime"
            )
        super().__init__(captures, config)
        root = resolve_home(self.config, QUICKJS_HOME_ENV)
        if not root:
            raise FileNotFoundError(_BUILD_HINT)
        self._wasm = Path(root) / _WASM_NAME
        if not self._wasm.is_file():
            raise FileNotFoundError(
                f"no {_WASM_NAME} under {root}; {_BUILD_HINT}"
            )
        self._execution = WasmExecution(self._wasm, "js")

    async def version(self, env: dict[str, str]) -> RunResult:
        stdout, stderr, exit_code = await self._execution.run(
            ["qjs", "--version"], None, list(env.items()), WasmView()
        )
        if exit_code == 0:
            version = stdout.decode().strip()
            stdout = f"JavaScript (quickjs-ng {version})\n".encode()
        return RunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)

    async def run(
        self, args: RunArgs, context: RuntimeContext | None = None
    ) -> RunResult:
        context = context or self._capture_context()
        # --std exposes the std/os globals (stdin via std.in); -m selects
        # ES-module mode for .mjs sources, and --script names classic mode
        # for the rest, since qjs takes -e source for a module unless told
        # (a sloppy `x = 5` then fails strict). Trailing args become
        # scriptArgs.
        argv = [
            "qjs",
            "--std",
            "-m" if args.flags.get("module") else "--script",
        ]
        # A named program takes scriptArgs[0], the slot qjs fills with a
        # script's path when it runs a file; unnamed -e leaves the args
        # alone, so the js command keeps its spelling.
        #
        # `--` is load-bearing: unlike CPython's -c, qjs's -e does NOT end
        # its option parsing, so a program argument that spells a qjs
        # switch is read as one. Without it, `node - -e prog` runs prog
        # instead of the piped program (a second -e wins) and `node - -m`
        # silently flips module mode. qjs consumes the `--` itself and
        # starts scriptArgs after it, and the -e branch still wins over
        # any filename (quickjs-ng v0.15.1 qjs.c).
        named = [args.prog] if args.prog else []
        cwd = args.cwd or (context.cwd if context is not None else None)
        source = args.code
        if cwd is not None and cwd.virtual != "/":
            # Evaluate scripts separately so their directive prologue still
            # controls strict mode. Modules are already strict.
            if args.flags.get("module") and source.startswith("#!"):
                source = "//" + source[2:]
            if not args.flags.get("module"):
                source = f"std.evalScript({json.dumps(source)});"
            source = cwd_preamble(cwd) + source
        argv += ["-e", source, "--", *named, *args.args]
        fs = WasmView(files=RuntimeFiles.of(context))
        stdout, stderr, exit_code = await self._execution.run(
            argv=argv,
            stdin=args.stdin,
            env=list(args.env.items()),
            fs=fs,
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)

    async def close(self) -> None:
        await self._execution.close()
