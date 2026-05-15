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
import posixpath
import sys
from typing import Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _resolve_script(name: str, cwd: PathSpec | None) -> PathSpec:
    if name.startswith("/"):
        path = posixpath.normpath(name)
    else:
        base = cwd.original.rstrip("/") if cwd is not None else ""
        path = posixpath.normpath((base + "/" + name) if base else "/" + name)
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(original=path, directory=directory, resolved=True)


async def _run_python_subprocess(
    code: str,
    stdin_data: bytes | None,
    args: list[str],
    env: dict[str, str] | None,
) -> tuple[bytes, bytes | None, int]:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            **(env or {})
        },
    )
    stdout, stderr = await proc.communicate(input=stdin_data)
    return stdout, stderr or None, proc.returncode


async def _python3(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    c: str | None = None,
    stdin: ByteSource | None = None,
    dispatch: Callable | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
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
        arg_strs = [p.original for p in paths] + text_list
    elif paths:
        script_path = paths[0]
        arg_strs = [p.original for p in paths[1:]] + text_list
    elif text_list:
        script_path = _resolve_script(text_list[0], cwd)
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
            err = f"python3: {script_path.original}: No such file\n".encode()
            return None, IOResult(exit_code=1, stderr=err)
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""

    stdin_data = await _read_stdin_async(stdin)
    if code is None:
        if stdin_data:
            code = stdin_data.decode(errors="replace")
            stdin_data = None
        else:
            return None, IOResult(exit_code=1, stderr=b"python3: no input\n")

    stdout, stderr, exit_code = await _run_python_subprocess(
        code, stdin_data, arg_strs, env)
    return stdout if stdout else None, IOResult(
        exit_code=exit_code,
        stderr=stderr,
    )


python3 = command("python3", resource=None, spec=SPECS["python3"])(_python3)
python_cmd = command("python", resource=None, spec=SPECS["python"])(_python3)
