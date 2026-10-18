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
from collections.abc import Sequence
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.sandbox.config import SandboxConfig, check_mount_type
from mirage.runtime.sandbox.mounts import SandboxMounts
from mirage.runtime.types import (
    MountType,
    RunResult,
    RuntimeReach,
    SandboxPipe,
)
from mirage.types import PathSpec


async def _piped(ctx: Context) -> bytes | None:
    """The bytes piped into a run, read whole; None when nothing was.

    Args:
        ctx (Context): the run's context.
    """
    return await materialize(ctx.stdin) if ctx.stdin is not None else None


class RemoteSandbox(Runtime[None], LineExecutorMixin[None]):
    """A runtime that executes programs in a sandbox the user runs.

    Captures default to unresolved program names. An explicit "*"
    delegates whole shell lines.

    Mirage never creates, provisions, or deletes sandboxes: you bring
    your own (a running container, a live Daytona or E2B sandbox) and
    the provider config says how to reach it. The workspace reaches
    the sandbox at the same prefixes as the host's, so the session cwd
    and every path in a line resolve unchanged: a provider with a
    ``mount_type`` serves them itself (SandboxMounts), otherwise serve
    them inside it yourself (``mirage workspace create`` in the image
    entrypoint or by hand). The whole-line entry point is
    LineExecutorMixin's run_line, and there is no interpreter entry
    point. Subclasses adapt one provider by implementing connect() and
    exec_line(), and open_pipe() for a ``mount_type``; routing and
    captures are inherited. Constructed like every runtime (captures,
    config); config is how to reach the sandbox, coerced through the
    provider's own config class.
    """

    # Lines execute on the provider's machine and act on that
    # machine's world (its filesystem, its network); the workspace
    # gate never sees those effects, however well isolated the
    # sandbox itself is.
    reach: RuntimeReach = "remote"
    captures: tuple[str, ...] = (EXTERNAL_COMMANDS,)
    config_cls: ClassVar[type[SandboxConfig]] = SandboxConfig
    config: SandboxConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: SandboxConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        # Connect-once latch: the first captured line connects; later
        # lines just execute. A failed connect leaves it unset so the
        # next line retries.
        self._connected = False
        self._connect_lock = asyncio.Lock()
        self._mounts: SandboxMounts | None = None
        check_mount_type(self.name, self.config.mount_type)
        if self.config.mount_type is not None:
            if type(self).open_pipe is RemoteSandbox.open_pipe:
                raise ValueError(
                    f"{self.name}: mount_type needs a pipe transport"
                )
            self._serve_mounts(self.config.mount_type)

    @property
    def file_effects_dispatched(self) -> bool:
        return (
            self._mounts is not None
            and self._mounts.file_effects_dispatched
            and self._binding is not None
            and self._binding.mount_prefixes is not None
            and "/" not in self._binding.mount_prefixes()
        )

    def _serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        return self._mounts is not None and all(
            prefix.rstrip("/") not in ("", "/dev")
            for prefix in restricted_mounts
        )

    async def run_line(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> RunResult:
        """Run one raw line in the sandbox, connecting once.

        The line, cwd, and paths pass through verbatim: the sandbox is
        expected to serve the workspace at the same prefixes as the
        host, so nothing is rewritten. The session environment merges
        over the config environment.

        Args:
            engine (None): a sandbox keeps its own connection.
            paths (list[PathSpec]): unused; the line names its paths.
            texts (list[str]): unused.
            ctx (Context): the line in ``flags["c"]``, the bytes piped
                into it, the session environment and working directory.
        """
        refusal = await self._prepare()
        if refusal is not None:
            return refusal
        line = ctx.flags.get("c")
        return await self.exec_line(
            line if isinstance(line, str) else "",
            await _piped(ctx),
            {**self.config.env, **(ctx.env or {})},
            ctx.cwd.virtual,
        )

    async def run_process(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> RunResult:
        refusal = await self._prepare()
        if refusal is not None:
            return refusal
        return await self._exec_argv(
            tuple(texts),
            await _piped(ctx),
            {**self.config.env, **(ctx.env or {})},
            ctx.cwd.virtual,
        )

    async def settle(self) -> None:
        if self._mounts is not None:
            await self._mounts.sync()

    async def _prepare(self) -> RunResult | None:
        await self._ensure_connected()
        if self._mounts is None:
            return None
        refusal = await self._mounts.admit(self._binding)
        if refusal is None:
            return None
        return RunResult(
            stdout=b"",
            stderr=f"{self.name}: {refusal}\n".encode(),
            exit_code=1,
        )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: bytes | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        raise NotImplementedError

    def _serve_mounts(self, mount_type: MountType | None) -> None:
        """Let the sandbox see the workspace by ``mount_type``.

        Args:
            mount_type (MountType | None): ssh, fuse or both; None
                serves nothing.
        """
        if mount_type is not None:
            self._mounts = SandboxMounts(
                self.name, mount_type, self._setup, self.open_pipe
            )

    async def _setup(self, line: str) -> RunResult:
        return await self.exec_line(line, None, dict(self.config.env), "/")

    async def _ensure_connected(self) -> None:
        async with self._connect_lock:
            if not self._connected:
                await self.connect()
                self._connected = True

    async def connect(self) -> None:
        """Attach to the user's live sandbox, failing loud if absent."""
        raise NotImplementedError

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        """Execute one shell line inside the sandbox.

        Args:
            line (str): the raw shell line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
        """
        return await self._exec_argv(("sh", "-c", line), stdin, env, cwd)

    async def open_pipe(self, command: str) -> SandboxPipe:
        """Start a command in the sandbox with its stdin and stdout held
        open, byte for byte, for a ``mount_type``'s SFTP.

        Args:
            command (str): the shell command.
        """
        raise NotImplementedError

    async def close(self) -> None:
        """Unmount what the sandbox was served; the sandbox is the user's."""
        if self._mounts is not None:
            await self._mounts.close()
        await super().close()
