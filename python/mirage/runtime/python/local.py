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
import sys

from mirage.runtime.python.base import (PythonRunArgs, PythonRunResult,
                                        PythonRuntime)


class LocalRuntime(PythonRuntime):
    """Run Python code on the host interpreter as a subprocess.

    Each run spawns `sys.executable -c <code>`; the code sees the host
    filesystem and environment, not the workspace mounts.
    """

    name = "local"

    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
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
        stdout, stderr = await proc.communicate(input=args.stdin)
        return PythonRunResult(
            stdout=stdout,
            stderr=stderr or None,
            exit_code=proc.returncode if proc.returncode is not None else 1,
        )
