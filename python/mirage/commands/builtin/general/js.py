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

from typing import Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.utils.paths import resolve_script
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.js import JsRunArgs, JsRuntime, QuickJsRuntime
from mirage.types import PathSpec


async def _js(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    e: str | None = None,
    m: bool = False,
    module: bool = False,
    stdin: ByteSource | None = None,
    dispatch: Callable | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
    js_runtime: JsRuntime | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not exec_allowed:
        err = b"js: root mount '/' is not in EXEC mode\n"
        return None, IOResult(exit_code=126, stderr=err)

    paths = paths or []
    text_list = list(texts)
    code: str | None = e
    has_code = code is not None
    script_path: PathSpec | None = None
    arg_strs: list[str]
    if has_code:
        arg_strs = [p.virtual for p in paths] + text_list
    elif paths:
        script_path = paths[0]
        arg_strs = [p.virtual for p in paths[1:]] + text_list
    elif text_list:
        script_path = resolve_script(text_list[0], cwd)
        arg_strs = text_list[1:]
    else:
        arg_strs = []

    as_module = m or module or (script_path is not None
                                and script_path.virtual.endswith(".mjs"))

    if code is None and script_path is not None:
        if dispatch is None:
            err = b"js: no dispatch available to read script\n"
            return None, IOResult(exit_code=1, stderr=err)
        try:
            data, _ = await dispatch("read", script_path)
        except FileNotFoundError:
            err = f"js: {script_path.virtual}: No such file\n".encode()
            return None, IOResult(exit_code=1, stderr=err)
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""

    stdin_data = await _read_stdin_async(stdin)
    if code is None:
        if stdin_data:
            code = stdin_data.decode(errors="replace")
            stdin_data = None
        else:
            return None, IOResult(exit_code=1, stderr=b"js: no input\n")

    if js_runtime is not None:
        runtime = js_runtime
    else:
        try:
            runtime = QuickJsRuntime()
        except (ImportError, FileNotFoundError) as exc:
            return None, IOResult(exit_code=127,
                                  stderr=f"js: {exc}\n".encode())
    result = await runtime.run(
        JsRunArgs(code=code,
                  args=arg_strs,
                  env=env or {},
                  stdin=stdin_data,
                  module=as_module))
    return result.stdout if result.stdout else None, IOResult(
        exit_code=result.exit_code,
        stderr=result.stderr,
    )


js = command("js", resource=None, spec=SPECS["js"])(_js)
node = command("node", resource=None, spec=SPECS["node"])(_js)
