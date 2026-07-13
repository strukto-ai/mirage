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
import shutil
import sys

from mirage.runtime.python.base import (PythonRunArgs, PythonRunResult,
                                        PythonRuntime)

LOCAL_PYTHON_ENV = "MIRAGE_LOCAL_PYTHON"


class LocalRuntime(PythonRuntime):
    """Run Python code on a host interpreter as a subprocess.

    Each run spawns `<interpreter> -c <code>`; the code sees the host
    filesystem and environment, not the workspace mounts. Cancelling the
    run kills the subprocess, so a safeguard timeout reclaims it.

    The interpreter defaults to the one running mirage; point
    `local_python` (the yaml `runtime: local_python:` key ends up here)
    or the MIRAGE_LOCAL_PYTHON environment variable at another binary,
    e.g. a project venv whose packages the code needs.

    Args:
        local_python (str | None): interpreter path or command name.
            None reads MIRAGE_LOCAL_PYTHON, then falls back to
            `sys.executable`.
    """

    name = "local"

    def __init__(self, local_python: str | None = None) -> None:
        chosen = local_python or os.environ.get(LOCAL_PYTHON_ENV)
        if chosen:
            resolved = shutil.which(chosen)
            if resolved is None:
                raise FileNotFoundError(
                    f"local python interpreter not found: {chosen!r} "
                    "(from the yaml `runtime: local_python:` key, the "
                    "Workspace `local_python` argument, or "
                    f"{LOCAL_PYTHON_ENV})")
            self._python = resolved
        else:
            self._python = sys.executable

    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        proc = await asyncio.create_subprocess_exec(
            self._python,
            "-c",
            args.code,
            *args.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={
                **os.environ,
                **args.env
            },
        )
        try:
            stdout, stderr = await proc.communicate(input=args.stdin)
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        return PythonRunResult(
            stdout=stdout,
            stderr=stderr or None,
            exit_code=proc.returncode if proc.returncode is not None else 1,
        )
