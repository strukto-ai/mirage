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
from typing import Any

from mirage.io.types import ByteSource
from mirage.machine.constants import EXEC_PRELUDE, not_running_hint
from mirage.machine.microsandbox.config import MicrosandboxConfig
from mirage.machine.microsandbox.constants import (
    INSPECT_TIMEOUT_SECONDS,
    MICROSANDBOX_HINT,
    PAUSED_STATE,
    RUNNING_STATE,
    SANDBOX_GONE,
    own_session,
)
from mirage.machine.program import (
    exec_args,
    open_program_pipe,
    reported_state,
)
from mirage.machine.transport import ProgramMachine
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunResult


class MicrosandboxMachine(ProgramMachine):
    """Run programs in an existing Microsandbox guest through `msb`.

    The user starts the sandbox and serves its workspace at the same
    paths inside the guest. Mirage forwards commands, stdin, environment,
    and cwd. It pauses the sandbox only when the workspace pauses and its
    config says ``on_pause: pause`` or the call names it, and the next
    connect resumes it.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (MicrosandboxConfig | dict[str, Any] | None): the sandbox to reach.
    """

    provider = "microsandbox"
    pauses = True
    config_cls = MicrosandboxConfig
    config: MicrosandboxConfig
    program = "msb"
    install_hint = MICROSANDBOX_HINT

    @property
    def instance(self) -> str:
        """The guest msb runs it in."""
        return self.config.sandbox

    def exec_words(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return ("exec", self.config.sandbox, "--quiet"), ("--",)

    _closing = False

    def __init__(
        self,
        name: str,
        config: MicrosandboxConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(name, config)
        # Every exec probes outside the connect latch; close waits for these.
        self._probes: set[asyncio.Task[None]] = set()
        # Bumped by each close: a probe it could not wait for marks nothing.
        self._generation = 0

    async def close(self) -> None:
        """Close as any machine does, once the probes under way have
        settled, so a resume they started is paused after; the cleanup's
        probes never resume a sandbox paused meanwhile."""
        self._closing = True
        try:
            # A probe on another loop (``with ws:``, closing on the sync
            # bridge) cannot be awaited here, and its loop is blocked anyway.
            loop = asyncio.get_running_loop()
            await asyncio.gather(
                *(p for p in self._probes if p.get_loop() is loop),
                return_exceptions=True,
            )
            self._generation += 1
            await super().close()
        finally:
            self._closing = False

    async def ensure_connected(self) -> None:
        """Skip the connect-once latch: every exec probes the guest."""

    async def connect(self) -> None:
        """Require a running sandbox before executing any commands,
        resuming a paused one unless the workspace is closing."""
        probe = asyncio.ensure_future(self._probe())
        self._probes.add(probe)
        probe.add_done_callback(self._probes.discard)
        await probe

    async def _probe(self) -> None:
        generation = self._generation
        sandbox = self.config.sandbox
        try:
            async with asyncio.timeout(INSPECT_TIMEOUT_SECONDS):
                status = await self._exec_program(
                    ["status", sandbox, "--format", "json"]
                )
        except TimeoutError as error:
            raise RuntimeError(
                f"msb status timed out after {INSPECT_TIMEOUT_SECONDS} seconds"
            ) from error
        state = reported_state(status, "msb status", ("status",))
        if state == PAUSED_STATE and not self._closing:
            await self._change_state(["resume", sandbox, "--quiet"])
        elif state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(
                    "sandbox", sandbox, state, {}, "start it with msb start"
                )
            )
        if generation == self._generation:
            self._reached = True

    def config_asks_to_pause(self) -> bool:
        """Whether the config says ``on_pause: pause``."""
        return self.config.on_pause == "pause"

    async def _pause_machine(self) -> None:
        """Suspend the sandbox, keeping its memory on the host; the next
        connect resumes it."""
        await self._change_state(
            ["pause", self.config.sandbox, "--quiet"], SANDBOX_GONE
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
        # Piped stdin skips --stream: msb fails more runs that close it early.
        words, tail = self.exec_words()
        head = words if stdin is not None else (*words, "--stream")
        return await self._exec_program(
            exec_args(
                head,
                tail,
                env,
                None,
                ("/bin/sh", "-c", EXEC_PRELUDE, "sh", cwd, *own_session(argv)),
            ),
            stdin=stdin,
            output=output,
            errors=errors,
        )

    async def open_pipe(self, command: str) -> MachinePipe:
        """Hold a byte-preserving msb stream open for guest sshfs."""
        await self.connect()
        head, tail = self.exec_words()
        return await open_program_pipe(
            self.program,
            exec_args(
                (*head, "--stream"),
                tail,
                {},
                None,
                ("/bin/sh", "-c", command),
            ),
        )
