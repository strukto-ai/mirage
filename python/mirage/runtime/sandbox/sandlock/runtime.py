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
from collections.abc import Sequence
from typing import Any, Callable

from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.sandbox.sandlock.config import SandlockConfig
from mirage.runtime.sandbox.sandlock.constants import (SANDLOCK_CLI_HINT,
                                                       SYSTEM_READABLE)
from mirage.runtime.types import ProcessExecution, RunResult, ScriptSource
from mirage.types import PathSpec


class SandlockRuntime(Runtime, LineExecutorMixin, ProcessExecutorMixin):
    """Run native commands through the Linux Sandlock CLI.

    Paths are native paths. Workspace files require an existing filesystem
    mount granted through fs_readable/fs_writable.
    """

    name = "sandlock"
    captures = (EXTERNAL_COMMANDS, )
    config_cls = SandlockConfig
    config: SandlockConfig

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        super().__init__(captures, config, script)
        self._children: set[asyncio.subprocess.Process] = set()

    def policy_argv(self) -> list[str]:
        argv: list[str] = []
        system = tuple(path for path in SYSTEM_READABLE
                       if os.path.exists(path))
        for path in (*system, *self.config.fs_readable):
            argv += ["-r", path]
        for path in self.config.fs_writable:
            argv += ["-w", path]
        if self.config.max_memory is not None:
            argv += ["-m", self.config.max_memory]
        return argv

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        return await self.run_process(
            ProcessExecution(argv=("/bin/sh", "-c", line),
                             cwd=PathSpec.from_str_path(cwd),
                             env=env,
                             stdin=stdin))

    async def run_process(self, request: ProcessExecution) -> RunResult:
        if not request.argv:
            raise ValueError("process argv must not be empty")
        cli = shutil.which("sandlock")
        if cli is None:
            raise FileNotFoundError(SANDLOCK_CLI_HINT)
        argv = ["run", *self.policy_argv(), "--clean-env"]
        for key, value in {**self.config.env, **request.env}.items():
            argv += ["--env", f"{key}={value}"]
        # Variables belong to the confined child, never the wrapper's loader.
        proc = await asyncio.create_subprocess_exec(
            cli,
            *argv,
            "--",
            *request.argv,
            cwd=request.cwd.virtual,
            env={},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        self._children.add(proc)
        try:
            stdout, stderr = await proc.communicate(request.stdin)
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            raise
        finally:
            self._children.discard(proc)
        return RunResult(
            stdout=stdout,
            stderr=stderr or None,
            exit_code=proc.returncode if proc.returncode is not None else 1)

    async def close(self) -> None:
        children = tuple(self._children)
        for child in children:
            if child.returncode is None:
                child.kill()
        await asyncio.gather(*(child.wait() for child in children))
