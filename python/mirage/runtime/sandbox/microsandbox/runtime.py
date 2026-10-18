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
import json
import logging
from collections.abc import Sequence
from contextvars import Context
from typing import Any

from mirage.commands.config import Context as CommandContext
from mirage.io.types import materialize
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.cli import run_cli
from mirage.runtime.sandbox.microsandbox.config import MicrosandboxConfig
from mirage.runtime.sandbox.microsandbox.constants import (
    INSPECT_TIMEOUT_SECONDS,
    MICROSANDBOX_CLI_HINT,
    PRELUDE,
    RUNNING_STATE,
    not_running_hint,
)
from mirage.runtime.types import RunResult, SandboxPipe
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


class MicrosandboxRuntime(RemoteSandbox, ProcessExecutorMixin[None]):
    """Run programs in an existing Microsandbox guest through the msb CLI.

    The user starts the sandbox and serves its workspace at the same
    paths inside the guest. Mirage forwards commands, stdin, environment,
    and cwd without managing the sandbox's lifecycle.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (MicrosandboxConfig | dict[str, Any] | None): the sandbox to reach.
    """

    name = "microsandbox"
    config_cls = MicrosandboxConfig
    config: MicrosandboxConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: MicrosandboxConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)

    async def _microsandbox(
        self, args: list[str], stdin: bytes | None = None
    ) -> tuple[bytes, bytes, int]:
        """Run one msb CLI invocation."""
        return await run_cli("msb", MICROSANDBOX_CLI_HINT, args, stdin)

    async def connect(self) -> None:
        """Require a running sandbox before executing any commands."""
        try:
            async with asyncio.timeout(INSPECT_TIMEOUT_SECONDS):
                await self._connect()
        except TimeoutError as error:
            raise RuntimeError(
                "msb runtime inspection timed out after 10 seconds"
            ) from error

    async def _connect(self) -> None:
        args = [
            "status",
            self.config.sandbox,
            "--format",
            "json",
        ]
        stdout, stderr, code = await self._microsandbox(args)
        if code != 0:
            raise RuntimeError(f"msb status failed: {stderr.decode().strip()}")
        try:
            status = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"msb status returned unreadable json: {exc}"
            ) from exc
        if not isinstance(status, dict):
            raise RuntimeError("msb status returned an invalid status object")
        state = status.get("status")
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(self.config.sandbox, str(state))
            )

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        return await self._exec_argv(("sh", "-c", line), stdin, env, cwd)

    async def run_line(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: CommandContext,
    ) -> RunResult:
        """Admit mounts, then validate the guest immediately before execution.

        Args:
            engine (None): no provider engine.
            paths (list[PathSpec]): unused.
            texts (list[str]): unused.
            ctx (CommandContext): line, input, environment and working directory.
        """
        refusal = await self._admit_mounts()
        if refusal is not None:
            return refusal
        line = ctx.flags.get("c")
        return await self.exec_line(
            line if isinstance(line, str) else "",
            await materialize(ctx.stdin) if ctx.stdin is not None else None,
            {**self.config.env, **(ctx.env or {})},
            ctx.cwd.virtual,
        )

    async def run_process(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: CommandContext,
    ) -> RunResult:
        refusal = await self._admit_mounts()
        if refusal is not None:
            return refusal
        return await self._exec_argv(
            tuple(texts),
            await materialize(ctx.stdin) if ctx.stdin is not None else None,
            {**self.config.env, **(ctx.env or {})},
            ctx.cwd.virtual,
        )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: bytes | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        # Released msb can still auto-start a guest stopped after this probe.
        await self.connect()
        args = [
            "exec",
            self.config.sandbox,
            "--quiet",
            "--no-tty",
            "-w",
            "/",
        ]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        # `--` ends the flags: the command is a trailing var arg, so a
        # line starting with a dash would otherwise parse as one.
        # Released agents block their event loop during chdir into passive SSHFS.
        # Defer it until the shell starts, so the agent can serve the mount pipe.
        args += [
            "--",
            "sh",
            "-c",
            PRELUDE,
            "sh",
            cwd,
            *argv,
        ]
        stdout, stderr, code = await self._microsandbox(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def open_pipe(self, command: str) -> SandboxPipe:
        """Hold a byte-preserving msb stream open for guest sshfs."""
        await self.connect()
        try:
            process = await asyncio.create_subprocess_exec(
                "msb",
                "exec",
                self.config.sandbox,
                "--quiet",
                "--no-tty",
                "--stream",
                "-w",
                "/",
                "--",
                "sh",
                "-c",
                command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise RuntimeError(MICROSANDBOX_CLI_HINT) from None
        assert process.stdin is not None and process.stdout is not None
        assert process.stderr is not None
        diagnostics = bytearray()

        async def drain_stderr() -> None:
            assert process.stderr is not None
            try:
                while chunk := await process.stderr.read(4096):
                    diagnostics.extend(chunk)
                    del diagnostics[:-16384]
            except Exception:
                logger.debug(
                    "microsandbox: reading mount pipe stderr failed",
                    exc_info=True,
                )

        draining = asyncio.create_task(drain_stderr(), context=Context())

        async def diagnostic() -> str:
            if not draining.done():
                try:
                    await asyncio.wait_for(asyncio.shield(draining), timeout=1)
                except TimeoutError:
                    logger.debug(
                        "microsandbox: returning partial mount pipe diagnostics"
                    )
            return diagnostics.decode(errors="replace").strip()

        async def stop() -> None:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
            if not draining.done():
                try:
                    await asyncio.wait_for(draining, timeout=1)
                except TimeoutError:
                    logger.debug(
                        "microsandbox: stderr did not close after the mount pipe exited"
                    )

        return SandboxPipe(
            process.stdout,
            process.stdin,
            stop,
            diagnostic,
        )
