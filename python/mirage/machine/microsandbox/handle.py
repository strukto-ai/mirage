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
from mirage.machine.constants import EXEC_PRELUDE, not_running_hint
from mirage.machine.microsandbox.config import MicrosandboxConfig
from mirage.machine.microsandbox.constants import (
    INSPECT_TIMEOUT_SECONDS,
    MICROSANDBOX_HINT,
    RUNNING_STATE,
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
    and cwd without managing the sandbox's lifecycle.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (MicrosandboxConfig | dict[str, Any] | None): the sandbox to reach.
    """

    provider = "microsandbox"
    config_cls = MicrosandboxConfig
    config: MicrosandboxConfig
    program = "msb"
    install_hint = MICROSANDBOX_HINT

    def exec_words(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return ("exec", self.config.sandbox, "--quiet"), ("--",)

    async def _ensure_connected(self) -> None:
        """Skip the connect-once latch: every exec probes the guest."""

    async def connect(self) -> None:
        """Require a running sandbox before executing any commands."""
        try:
            async with asyncio.timeout(INSPECT_TIMEOUT_SECONDS):
                await self._connect()
        except TimeoutError as error:
            raise RuntimeError(
                f"msb status timed out after {INSPECT_TIMEOUT_SECONDS} seconds"
            ) from error

    async def _connect(self) -> None:
        sandbox = self.config.sandbox
        status = await self._exec_program(
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
