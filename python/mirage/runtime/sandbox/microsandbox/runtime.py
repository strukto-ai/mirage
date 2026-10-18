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

from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.cli import open_cli_pipe, run_cli
from mirage.runtime.sandbox.constants import EXEC_PRELUDE
from mirage.runtime.sandbox.microsandbox.config import MicrosandboxConfig
from mirage.runtime.sandbox.microsandbox.constants import (
    INSPECT_TIMEOUT_SECONDS,
    MICROSANDBOX_CLI_HINT,
    RUNNING_STATE,
    not_running_hint,
)
from mirage.runtime.types import RunResult, SandboxPipe


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

    async def _ensure_connected(self) -> None:
        """Skip the connect-once latch: every exec probes the guest."""

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
                "msb runtime inspection timed out after "
                f"{INSPECT_TIMEOUT_SECONDS} seconds"
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
            EXEC_PRELUDE,
            "sh",
            cwd,
            *argv,
        ]
        stdout, stderr, code = await self._microsandbox(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def open_pipe(self, command: str) -> SandboxPipe:
        """Hold a byte-preserving msb stream open for guest sshfs."""
        await self.connect()
        return await open_cli_pipe(
            "msb",
            [
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
            ],
        )
