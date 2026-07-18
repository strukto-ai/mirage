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

from typing import Any, Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.utils.paths import resolve_script
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.python import MontyRuntime, PythonRunArgs, PythonRuntime
from mirage.types import PathSpec


async def _python3(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    c: str | None = None,
    stdin: ByteSource | None = None,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
    python_runtime: PythonRuntime | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not exec_allowed:
        err = b"python3: root mount '/' is not in EXEC mode\n"
        return None, IOResult(exit_code=126, stderr=err)

    paths = paths or []
    text_list = list(texts)
    code: str | None = c
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

    if code is None and script_path is not None:
        if dispatch is None:
            err = b"python3: no dispatch available to read script\n"
            return None, IOResult(exit_code=1, stderr=err)
        try:
            data, _ = await dispatch("read", script_path)
        except FileNotFoundError:
            err = f"python3: {script_path.virtual}: No such file\n".encode()
            return None, IOResult(exit_code=1, stderr=err)
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""

    stdin_data = await _read_stdin_async(stdin)
    if code is None:
        if stdin_data:
            code = stdin_data.decode(errors="replace")
            stdin_data = None
        else:
            return None, IOResult(exit_code=1, stderr=b"python3: no input\n")

    if python_runtime is not None:
        runtime = python_runtime
    else:
        try:
            runtime = MontyRuntime(dispatch)
        except ImportError as exc:
            return None, IOResult(exit_code=127,
                                  stderr=f"python3: {exc}\n".encode())
    result = await runtime.run(
        PythonRunArgs(code=code,
                      args=arg_strs,
                      env=env or {},
                      stdin=stdin_data))
    return result.stdout if result.stdout else None, IOResult(
        exit_code=result.exit_code,
        stderr=result.stderr,
    )


python3 = command("python3", resource=None, spec=SPECS["python3"])(_python3)
python_cmd = command("python", resource=None, spec=SPECS["python"])(_python3)
