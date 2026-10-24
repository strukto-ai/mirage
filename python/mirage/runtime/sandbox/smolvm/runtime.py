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


from mirage.io.types import ByteSource
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import not_running_hint
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.sandbox.program import (
    exec_args,
    open_program_pipe,
    reported_state,
    run_program,
)
from mirage.runtime.sandbox.smolvm.config import SmolvmConfig
from mirage.runtime.sandbox.smolvm.constants import (
    RUNNING_STATE,
    SMOLVM_HINT,
    STATE_HINTS,
)
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe


class SmolvmRuntime(RemoteSandbox, PipeTransportMixin):
    """A microVM the user runs as a whole-line runtime.

    You start the machine yourself; mirage only connects to it and
    execs lines. The `smolvm` program is the transport, so there is no SDK
    dependency and no daemon socket wiring; each line is one `smolvm
    machine exec` with the merged environment, the session cwd, real
    stdin, and separated stderr.

    Unlike a container, the guest runs its own kernel, so the line
    sees that kernel's filesystem and nothing of the host's except
    what the machine was given at boot (`--volume`). Serve the
    workspace inside the guest at the host's mount prefixes, the same
    contract every provider in this family carries.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (SmolvmConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    name = "smolvm"
    config_cls = SmolvmConfig
    config: SmolvmConfig

    async def _smolvm(
        self,
        args: list[str],
        stdin: ByteSource | None = None,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run `smolvm` once; the seam tests override."""
        return await run_program(
            "smolvm",
            SMOLVM_HINT,
            args,
            stdin,
            output=output,
            errors=errors,
        )

    async def connect(self) -> None:
        """Probe the machine, refusing any state that cannot take a line.

        `machine exec` would start a stopped machine on its own, but
        this family never manages sandbox lifecycle, so a machine that
        is not already running is an error rather than a boot.
        """
        machine = self.config.machine
        status = await self._smolvm(
            ["machine", "status", "--name", machine, "--json"]
        )
        state = reported_state(status, "smolvm machine status", ("state",))
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint("machine", machine, state, STATE_HINTS)
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
        return await self._smolvm(
            exec_args(self._head(), ("--",), env, cwd, argv),
            stdin=stdin,
            output=output,
            errors=errors,
        )

    async def open_pipe(self, command: str) -> SandboxPipe:
        return await open_program_pipe(
            "smolvm",
            exec_args(
                self._head(), ("--",), {}, None, ("/bin/sh", "-c", command)
            ),
        )

    def _head(self) -> tuple[str, ...]:
        return ("machine", "exec", "--name", self.config.machine, "-i")
