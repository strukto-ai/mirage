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
from mirage.machine.apple_container.config import AppleContainerConfig
from mirage.machine.apple_container.constants import (
    APPLE_CONTAINER_HINT,
    RUNNING_STATE,
    STATE_HINTS,
)
from mirage.machine.constants import not_running_hint
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.program import (
    exec_args,
    open_program_pipe,
    reported_state,
    run_program,
)
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe


class AppleContainerMachine(MachineHandle, PipeTransportMixin):
    """A container under Apple's `container` tool.

    You start the container yourself; mirage only connects to it and
    execs lines. The `container` program is the transport, so there is no
    SDK dependency and no XPC wiring; each line is one `container exec`
    with the merged environment, the session cwd, real stdin, and
    separated stderr.

    Each container is its own lightweight VM with its own Linux
    kernel, so, as in a smolvm guest, the line sees nothing of the
    host's filesystem except what the container was given at start
    (`--volume`). Serve the workspace inside it at the host's mount
    prefixes, the same contract every provider in this family carries.
    The image needs a POSIX /bin/sh, which every argv runs under
    (EXEC_PRELUDE).

    One machine is one container, so an agent gets a VM of its own as a
    machine of its own, which a policy route sends its session to.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (AppleContainerConfig | dict[str, Any] | None): container
            settings.
    """

    provider = "apple_container"
    config_cls = AppleContainerConfig
    config: AppleContainerConfig

    async def _container(
        self,
        args: list[str],
        stdin: ByteSource | None = None,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run `container` once.

        Args:
            args (list[str]): arguments after the executable.
            stdin (bytes | None): input delivered to the guest command.
        """
        return await run_program(
            "container",
            APPLE_CONTAINER_HINT,
            args,
            stdin,
            output=output,
            errors=errors,
        )

    async def connect(self) -> None:
        """Refuse a container in any state that cannot take a line.

        `container exec` refuses a container that is not running as
        well; probing up front names the state and how to recover.
        """
        container = self.config.container
        status = await self._container(["inspect", container])
        state = reported_state(
            status, "container inspect", (0, "status", "state")
        )
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint("container", container, state, STATE_HINTS)
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
        return await self._container(
            exec_args(
                ("exec", "-i"), (self.config.container,), env, cwd, argv
            ),
            stdin=stdin,
            output=output,
            errors=errors,
        )

    async def open_pipe(self, command: str) -> SandboxPipe:
        return await open_program_pipe(
            "container",
            exec_args(
                ("exec", "-i"),
                (self.config.container,),
                {},
                None,
                ("/bin/sh", "-c", command),
            ),
        )
