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


from mirage.machine.constants import not_running_hint
from mirage.machine.docker.config import DockerConfig
from mirage.machine.docker.constants import (
    CONTAINER_GONE,
    DOCKER_HINT,
    PAUSED_STATE,
    RUNNING_STATE,
)
from mirage.machine.program import reported_state
from mirage.machine.transport import ProgramMachine


class DockerMachine(ProgramMachine):
    """A running container, reached through ``docker exec``.

    You start the container yourself; mirage only connects to it and
    execs lines. The `docker` program is the transport (Docker Desktop,
    colima, or a podman alias all work), so there is no SDK dependency
    and no daemon socket wiring; each line is one `docker exec -i`
    with the merged environment, the session cwd, real stdin, and
    separated stderr.

    The container is yours: Mirage pauses it only when the workspace
    pauses and its config says ``on_pause: pause`` or the call names it,
    and the next connect unpauses it.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (DockerConfig | dict[str, Any] | None): how to reach the machine.
    """

    provider = "docker"
    pauses = True
    config_cls = DockerConfig
    config: DockerConfig
    program = "docker"
    install_hint = DOCKER_HINT

    @property
    def instance(self) -> str:
        """The container docker runs it in."""
        return self.config.container

    def exec_words(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return ("exec", "-i"), (self.config.container,)

    async def connect(self) -> None:
        container = self.config.container
        status = await self._exec_program(
            ["inspect", "--format", "{{json .State}}", container]
        )
        state = reported_state(status, "docker inspect", ("Status",))
        if state == PAUSED_STATE:
            await self._change_state(["unpause", container])
        elif state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint("container", container, state, {})
            )
        self._reached = True

    def config_asks_to_pause(self) -> bool:
        """Whether the config says ``on_pause: pause``."""
        return self.config.on_pause == "pause"

    async def _pause_machine(self) -> None:
        """Freeze the container's processes, which frees its CPU and keeps
        its memory; the next connect unpauses it."""
        await self._change_state(
            ["pause", self.config.container], CONTAINER_GONE
        )
