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

import os
import shutil
from collections.abc import Sequence
from typing import Any

from mirage.commands.config import Context
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, StreamingProcessMixin
from mirage.runtime.sandbox.cli import (
    Children,
    close_children,
    cwd_refusal,
    run_cli,
)
from mirage.runtime.sandbox.sandlock.config import SandlockConfig
from mirage.runtime.sandbox.sandlock.constants import (
    SANDLOCK_CLI_HINT,
    SYSTEM_READABLE,
)
from mirage.runtime.types import OutputFn, RunResult
from mirage.types import PathSpec


class SandlockRuntime(
    Runtime[None], LineExecutorMixin[None], StreamingProcessMixin[None]
):
    """Run native commands through the Linux Sandlock CLI.

    Paths are native paths. Workspace files require an existing filesystem
    mount granted through fs_readable/fs_writable.
    """

    name = "sandlock"
    captures = (EXTERNAL_COMMANDS,)
    config_cls = SandlockConfig
    config: SandlockConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: SandlockConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        if self.config.mount_type is not None:
            raise ValueError(
                "sandlock: mount_type needs a remote pipe transport"
            )
        self._children: Children = {}

    def policy_argv(self) -> list[str]:
        argv: list[str] = []
        system = tuple(
            path for path in SYSTEM_READABLE if os.path.exists(path)
        )
        for path in (*system, *self.config.fs_readable):
            argv += ["-r", path]
        for path in self.config.fs_writable:
            argv += ["-w", path]
        if self.config.max_memory is not None:
            argv += ["-m", self.config.max_memory]
        return argv

    async def run_line(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> RunResult:
        line = ctx.flags.get("c")
        return await self._run_process(
            ["/bin/sh", "-c", line if isinstance(line, str) else ""], ctx, None
        )

    async def run_process(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> RunResult:
        return await self._run_process(texts, ctx, None)

    async def run_stream(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn,
    ) -> RunResult:
        return await self._run_process(texts, ctx, output)

    async def _run_process(
        self, argv: list[str], ctx: Context, output: OutputFn | None
    ) -> RunResult:
        refusal = cwd_refusal(argv[0], ctx.cwd.virtual)
        if refusal is not None:
            return refusal
        cli = shutil.which("sandlock")
        if cli is None:
            raise FileNotFoundError(SANDLOCK_CLI_HINT)
        wrapper = ["run", *self.policy_argv(), "--clean-env"]
        for key, value in {**self.config.env, **(ctx.env or {})}.items():
            wrapper += ["--env", f"{key}={value}"]
        # Variables belong to the confined child, never the wrapper's loader.
        stdout, stderr, code = await run_cli(
            cli,
            None,
            [*wrapper, "--", *argv],
            ctx.stdin,
            cwd=ctx.cwd.virtual,
            env={},
            children=self._children,
            output=output,
        )
        return RunResult(stdout=stdout, stderr=stderr or None, exit_code=code)

    async def close(self) -> None:
        """Kill every child still running, so none outlives the workspace."""
        await close_children(self._children)
