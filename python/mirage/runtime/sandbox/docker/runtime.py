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
from mirage.runtime.sandbox.docker.config import DockerConfig
from mirage.runtime.sandbox.docker.constants import DOCKER_HINT, RUNNING_STATE
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.sandbox.program import (
    exec_args,
    open_program_pipe,
    reported_state,
    run_program,
)
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe


class DockerRuntime(RemoteSandbox, PipeTransportMixin):
    """A container the user runs as a whole-line runtime.

    You start the container yourself; mirage only connects to it and
    execs lines. The `docker` program is the transport (Docker Desktop,
    colima, or a podman alias all work), so there is no SDK dependency
    and no daemon socket wiring; each line is one `docker exec -i`
    with the merged environment, the session cwd, real stdin, and
    separated stderr.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (DockerConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    name = "docker"
    config_cls = DockerConfig
    config: DockerConfig

    async def _docker(
        self,
        args: list[str],
        stdin: ByteSource | None = None,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run `docker` once; the seam tests override."""
        return await run_program(
            "docker",
            DOCKER_HINT,
            args,
            stdin,
            output=output,
            errors=errors,
        )

    async def connect(self) -> None:
        container = self.config.container
        status = await self._docker(
            ["inspect", "--format", "{{json .State}}", container]
        )
        state = reported_state(status, "docker inspect", ("Status",))
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint("container", container, state, {})
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
        return await self._docker(
            exec_args(
                ("exec", "-i"), (self.config.container,), env, cwd, argv
            ),
            stdin=stdin,
            output=output,
            errors=errors,
        )

    async def open_pipe(self, command: str) -> SandboxPipe:
        return await open_program_pipe(
            "docker",
            exec_args(
                ("exec", "-i"),
                (self.config.container,),
                {},
                None,
                ("/bin/sh", "-c", command),
            ),
        )
