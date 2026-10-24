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

from mirage.io.types import ByteSource
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import not_running_hint
from mirage.runtime.sandbox.microsandbox.config import MicrosandboxConfig
from mirage.runtime.sandbox.microsandbox.constants import (
    INSPECT_TIMEOUT_SECONDS,
    MICROSANDBOX_HINT,
    RUNNING_STATE,
)
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.sandbox.program import (
    exec_args,
    open_program_pipe,
    reported_state,
    run_program,
)
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe


class MicrosandboxRuntime(RemoteSandbox, PipeTransportMixin):
    """Run programs in an existing Microsandbox guest through `msb`.

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
        self,
        args: list[str],
        stdin: ByteSource | None = None,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run `msb` once."""
        return await run_program(
            "msb",
            MICROSANDBOX_HINT,
            args,
            stdin,
            output=output,
            errors=errors,
        )

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
        sandbox = self.config.sandbox
        status = await self._microsandbox(
            ["status", sandbox, "--format", "json"]
        )
        state = reported_state(status, "msb status", ("status",))
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(
                    "sandbox", sandbox, state, {}, "start it with msb start"
                )
            )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        # Released msb can still auto-start a guest stopped after this probe.
        await self.connect()
        return await self._microsandbox(
            exec_args(self._head(), ("--",), env, cwd, argv),
            stdin=stdin,
            output=output,
            errors=errors,
        )

    async def open_pipe(self, command: str) -> SandboxPipe:
        """Hold a byte-preserving msb stream open for guest sshfs."""
        await self.connect()
        return await open_program_pipe(
            "msb",
            exec_args(
                (*self._head(), "--stream"),
                ("--",),
                {},
                None,
                ("/bin/sh", "-c", command),
            ),
        )

    def _head(self) -> tuple[str, ...]:
        return ("exec", self.config.sandbox, "--quiet")
