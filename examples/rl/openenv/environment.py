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

from examples.rl.backend import create_episode_workspace
from examples.rl.constants import SYSTEM_PROMPT
from examples.rl.openenv.constants import (
    DEFAULT_ACTION_TIMEOUT,
    DEFAULT_MAX_STEPS,
)
from examples.rl.openenv.utils import shell_action
from examples.rl.schemas import MirageTask
from examples.rl.server import ServerPool
from examples.rl.verifier import verify_workspace
from mirage import Workspace
from mirage.environments.openenv import (
    EpisodeSpec,
    MirageObservation,
    MirageOpenEnv,
)


class OpenEnvHarness:
    """Episode harness pairing ``MirageOpenEnv`` with ``ServerPool`` and tests.

    Each ``reset`` builds an isolated ``Workspace`` wired to fresh
    ``/_run/<run_id>`` backend endpoints, steps commands via
    ``MirageOpenEnv.step_async``, and grades via ``verify_workspace``.

    Args:
        task (MirageTask): Harbor-compatible Mirage task definition.
        servers (ServerPool): Shared pool of ``integ/server`` backends.
        max_steps (int): Maximum OpenEnv actions allowed per episode.
        timeout_s (float): Per-step action timeout in seconds.
    """

    def __init__(
        self,
        task: MirageTask,
        servers: ServerPool,
        max_steps: int = DEFAULT_MAX_STEPS,
        timeout_s: float = DEFAULT_ACTION_TIMEOUT,
    ) -> None:
        self.task = task
        self._servers = servers
        self._workspace: Workspace | None = None
        self.env = MirageOpenEnv(
            factory=self._build_workspace,
            max_steps=max_steps,
            timeout_s=timeout_s,
        )

    async def _build_workspace(self, _spec: EpisodeSpec) -> Workspace:
        ws = await create_episode_workspace(self.task, self._servers)
        self._workspace = ws
        return ws

    @property
    def workspace(self) -> Workspace:
        if self._workspace is None:
            raise RuntimeError("Episode has not been reset yet")
        return self._workspace

    async def reset(self, seed: int | None = None) -> MirageObservation:
        obs = await self.env.reset_async(seed=seed)
        assert isinstance(obs, MirageObservation)
        return obs

    async def step_shell(self, command: str) -> MirageObservation:
        obs = await self.env.step_async(shell_action(command))
        assert isinstance(obs, MirageObservation)
        return obs

    async def build_system_prompt(self) -> str:
        ws = self.workspace
        vfs_doc = await ws.vfs_md()
        skill_doc = await ws.skill_md()
        return f"{SYSTEM_PROMPT}\n\n{vfs_doc}\n\n{skill_doc}"

    async def grade(self) -> float:
        return await verify_workspace(self.workspace)

    async def close(self) -> None:
        await self.env.aclose()
        self._workspace = None
