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

import base64
import posixpath
from dataclasses import dataclass

import aiohttp

from mirage import (
    Context,
    PathSpec,
    ProcessExecutorMixin,
    RunResult,
    Runtime,
    RuntimeConfig,
)
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.types import OutputFn

# A runtime for an execution service Mirage does not ship: your team's job
# runner, a GPU box, a build farm. It is named from yaml as
# ``./remote_runtime.py:RemoteRuntime`` and captures every program Mirage
# does not run itself, so the agent's python3, node or make go to the
# service while cat, grep and pipes stay in the workspace.
#
# The service cannot see a mount, so the runtime sends it the session's
# working directory and writes back the files the program changed. Both go
# through ctx.vfs, the session's files, so mount modes, policy and the cache
# apply to them as they apply to cp: a read-only mount refuses the
# write-back.


@dataclass(frozen=True, slots=True)
class RemoteConfig(RuntimeConfig):
    """The yaml entry's ``config`` block; an unknown key fails at load.

    Args:
        url (str): the execution service's run endpoint.
        max_bytes (int): the most bytes one run sends, for the working
            directory and for stdin each.
    """

    url: str = ""
    max_bytes: int = 16 * 1024 * 1024


class RemoteRuntime(
    Runtime[aiohttp.ClientSession], ProcessExecutorMixin[aiohttp.ClientSession]
):
    name = "remote"
    captures = ("python3", "python", "node", EXTERNAL_COMMANDS)
    reach = "remote"
    config_cls = RemoteConfig
    config: RemoteConfig

    async def open_engine(self) -> aiohttp.ClientSession:
        """One HTTP session, opened at the first run and shared by all."""
        return aiohttp.ClientSession()

    async def close_engine(self, engine: aiohttp.ClientSession) -> None:
        """Close the HTTP session when the workspace closes.

        Args:
            engine (aiohttp.ClientSession): the session open_engine made.
        """
        await engine.close()

    async def run_process(
        self,
        engine: aiohttp.ClientSession,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run one program on the service, in a copy of the working
        directory.

        Cancelling the run (``timeout``, a closed session) cancels the
        request, and the service stops the program when the connection
        drops.

        Args:
            engine (aiohttp.ClientSession): the shared HTTP session.
            paths (list[PathSpec]): unused; a process gets its argv as
                words.
            texts (list[str]): the argv, program first.
            ctx (Context): the session's cwd, stdin and files.
            output (OutputFn | None): unused; the output comes back
                whole in the result.
            errors (OutputFn | None): unused, the same for stderr.
        """
        cwd = ctx.cwd.virtual
        files = await self._snapshot(ctx, cwd)
        stdin = await self._stdin(ctx)
        request = {
            "argv": texts,
            "stdin": _b64(stdin),
            "files": {rel: _b64(data) for rel, data in files.items()},
        }
        async with engine.post(self.config.url, json=request) as resp:
            resp.raise_for_status()
            answer = await resp.json()
        for rel, data in answer["files"].items():
            folder = cwd
            for part in (
                posixpath.dirname(rel).split("/") if "/" in rel else []
            ):
                folder = posixpath.join(folder, part)
                if not await ctx.vfs.exists(folder):
                    await ctx.vfs.mkdir(folder)
            await ctx.vfs.write(
                posixpath.join(cwd, rel), base64.b64decode(data)
            )
        return RunResult(
            stdout=base64.b64decode(answer["stdout"]),
            stderr=base64.b64decode(answer["stderr"]) or None,
            exit_code=answer["exit_code"],
        )

    async def _stdin(self, ctx: Context) -> bytes:
        # The service takes a run's input whole, so stop reading at the
        # budget: an endless producer fails the run instead of hanging it.
        if ctx.stdin is None:
            return b""
        data = bytearray()
        source = ctx.stdin if not isinstance(ctx.stdin, bytes) else None
        if source is None:
            data += ctx.stdin
        else:
            async for chunk in source:
                data += chunk
                if len(data) > self.config.max_bytes:
                    break
        if len(data) > self.config.max_bytes:
            raise ValueError(f"stdin is over {self.config.max_bytes} bytes")
        return bytes(data)

    async def _snapshot(self, ctx: Context, cwd: str) -> dict[str, bytes]:
        files: dict[str, bytes] = {}
        total = 0
        mount = ctx.vfs.mount_of(cwd)
        pending = [cwd]
        while pending:
            folder = pending.pop()
            for entry in await ctx.vfs.readdir(folder):
                # Copy the working directory's own mount only: another
                # mount below it (or /dev under the root) stays behind.
                if ctx.vfs.mount_of(entry) != mount:
                    continue
                if await ctx.vfs.is_dir(entry):
                    pending.append(entry)
                    continue
                data = await ctx.vfs.read(entry, raw=True)
                total += len(data)
                if total > self.config.max_bytes:
                    raise ValueError(
                        f"working directory is over {self.config.max_bytes} bytes"
                    )
                files[posixpath.relpath(entry, cwd)] = data
        return files


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()
