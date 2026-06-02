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
from collections.abc import AsyncIterator
from pathlib import Path


async def native_exec(
    command: str,
    cwd: str | Path,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    name: str | None = None,
) -> tuple[bytes, bytes, int]:
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        msg = f"{name or command}: timed out after {timeout}s\n".encode()
        return b"", msg, 124
    return stdout, stderr, proc.returncode or 0


class NativeProcess:

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc

    async def stdout_stream(self,
                            chunk_size: int = 8192) -> AsyncIterator[bytes]:
        assert self._proc.stdout is not None
        while True:
            chunk = await self._proc.stdout.read(chunk_size)
            if not chunk:
                break
            yield chunk

    async def wait(self) -> int:
        return await self._proc.wait()

    @property
    def stderr(self) -> asyncio.StreamReader | None:
        return self._proc.stderr


async def native_exec_stream(
    command: str,
    cwd: str | Path,
    env: dict[str, str] | None = None,
) -> NativeProcess:
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    return NativeProcess(proc)
