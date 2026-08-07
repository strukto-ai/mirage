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
import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Callable, ClassVar

from mirage.runtime.config import HomeConfig, RuntimeConfig
from mirage.runtime.errors import EvalError
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.types import (DispatchFn, EvalResult, EvalValue,
                                  PrefixSource, RunArgs, RunResult,
                                  ScriptSource)
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

# The one-shot eval harness: inputs bind as globals, the source runs
# through indirect eval (global scope, completion value = the LAST
# EXPRESSION), and the value or error rides a sentinel line appended to
# stdout, the engine's only host-visible channel. Mirrors the TS
# quickjs evaluator semantics; the JSON shapes match EvalValue.
EVAL_SENTINEL = "__MIRAGE_EVAL__"

JS_EVAL_HARNESS = """\
const __mirage_inputs = JSON.parse({inputs_json});
for (const __k of Object.keys(__mirage_inputs))
  globalThis[__k] = __mirage_inputs[__k];
let __mirage_payload;
try {{
  const __mirage_value = (0, eval)({source_json});
  __mirage_payload =
    {{ value: __mirage_value === undefined ? null : __mirage_value }};
}} catch (__e) {{
  __mirage_payload = {{ error: {{
    name: (__e && __e.name) || 'Error',
    message: (__e && __e.message) || String(__e),
  }} }};
}}
std.out.puts('\\n{sentinel}' + JSON.stringify(__mirage_payload) + '\\n');
"""


class QuickJsRuntime(JsRuntime, EvaluatorMixin):
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
        self._dispatch: DispatchFn | None = None
        self._mount_prefixes: PrefixSource | None = None
        self._runtime = WasmRuntime(self._wasm, "js")

    def attach(self, dispatch: DispatchFn,
               mount_prefixes: PrefixSource) -> None:
        if self._dispatch is None:
            self._dispatch = dispatch
            self._mount_prefixes = mount_prefixes

    async def run(self, args: RunArgs) -> RunResult:
        # --std exposes the std/os globals (stdin via std.in); -m selects
        # ES-module mode for .mjs sources. Trailing args become scriptArgs.
        argv = ["qjs", "--std"]
        if args.flags.get("module"):
            argv.append("-m")
        # A named program takes scriptArgs[0], the slot qjs fills with a
        # script's path when it runs a file; unnamed -e leaves the args
        # alone, so the js command keeps its spelling.
        named = [args.prog] if args.prog else []
        argv += ["-e", args.code, *named, *args.args]
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

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        """Evaluate one JS program; the completion value is the value.

        Inputs bind as globals and the source runs at global scope via
        indirect eval, so the LAST EXPRESSION is the value (what the
        policy engine consumes for JS policy scripts). Each eval is a
        fresh engine; the wasi build has no persistent interpreter, so
        console sessions are not supported.

        Args:
            code (str): the JS source to evaluate.
            inputs (dict[str, EvalValue] | None): globals for the run.
            session (str | None): unsupported; a session id fails loud.

        Raises:
            EvalError: session requested, the program failed to parse
                or raised, or the value could not be carried back.
        """
        if session is not None:
            raise EvalError(
                "the quickjs evaluator is one-shot only: each eval is a "
                "fresh wasi engine, so console sessions are unsupported")
        harness = JS_EVAL_HARNESS.format(
            inputs_json=json.dumps(json.dumps(inputs or {})),
            source_json=json.dumps(code),
            sentinel=EVAL_SENTINEL,
        )
        result = await self.run(
            RunArgs(code=harness, args=[], stdin=None, env={}, flags={}))
        stdout = (result.stdout or b"").decode(errors="replace")
        marker = f"\n{EVAL_SENTINEL}"
        head, sep, tail = stdout.rpartition(marker)
        if not sep:
            stderr_text = (result.stderr or b"").decode(errors="replace")
            raise EvalError(f"quickjs eval produced no value: "
                            f"{stderr_text.strip() or 'engine failed'}")
        payload = json.loads(tail.strip() or "{}")
        if "error" in payload:
            name = str(payload["error"].get("name", "Error"))
            message = str(payload["error"].get("message", ""))
            raise EvalError(f"{name}: {message}", syntax=name == "SyntaxError")
        return EvalResult(value=payload.get("value"),
                          stdout=head.encode(),
                          stderr=result.stderr,
                          exit_code=0,
                          status="complete")
