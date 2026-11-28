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

from collections.abc import Sequence

from tinker_cookbook import model_info, tokenizer_utils
from tinker_cookbook.renderers import get_renderer
from tinker_cookbook.rl.types import Env, EnvGroupBuilder
from tinker_cookbook.tool_use import build_agent_tool_env

from examples.rl.backend import MirageRollout, create_mirage_rollout
from examples.rl.schemas import MirageTask
from examples.rl.server import ServerPool
from examples.rl.tinker.constants import (
    DEFAULT_MAX_TRAJECTORY_TOKENS,
    RECIPE_NAME,
)
from examples.rl.tinker.utils import MirageShellTool
from examples.rl.tinker.verifier import MirageVerifier


class MirageEnvGroupBuilder(EnvGroupBuilder):
    """Tinker EnvGroupBuilder backed by Mirage workspaces and verifiers.

    Args:
        task (MirageTask): Harbor-compatible Mirage task definition.
        servers (ServerPool): Shared pool of ``integ/server`` backends.
        model_name (str): Target Tinker model identifier.
        renderer_name (str | None): Optional renderer override.
        max_turns (int): Maximum agent turns per episode.
        group_size (int): Number of parallel rollouts per GRPO group.
        max_trajectory_tokens (int): Maximum cumulative trajectory tokens.
        max_generation_tokens (int | None): Optional per-turn generation cap.
    """

    def __init__(
        self,
        task: MirageTask,
        servers: ServerPool,
        model_name: str,
        renderer_name: str | None,
        max_turns: int,
        group_size: int,
        max_trajectory_tokens: int = DEFAULT_MAX_TRAJECTORY_TOKENS,
        max_generation_tokens: int | None = None,
    ) -> None:
        self.task = task
        self.servers = servers
        self.model_name = model_name
        self.renderer_name = renderer_name
        self.max_turns = max_turns
        self.group_size = group_size
        self.max_trajectory_tokens = max_trajectory_tokens
        self.max_generation_tokens = max_generation_tokens
        self._rollouts: list[MirageRollout] = []

    async def make_envs(self) -> Sequence[Env]:
        self._rollouts = []
        tokenizer = tokenizer_utils.get_tokenizer(self.model_name)
        r_name = self.renderer_name or (
            model_info.get_recommended_renderer_name(self.model_name)
        )
        renderer = get_renderer(r_name, tokenizer)

        envs: list[Env] = []
        for _ in range(self.group_size):
            rollout = await create_mirage_rollout(self.task, self.servers)
            self._rollouts.append(rollout)

            shell_tool = MirageShellTool(rollout.workspace)
            system_prompt = await rollout.build_system_prompt()
            prefix = renderer.create_conversation_prefix_with_tools(
                tools=[shell_tool.shell.to_spec()],
                system_prompt=system_prompt,
            )
            initial_messages = prefix + [
                {"role": "user", "content": self.task.instruction}
            ]

            envs.append(
                build_agent_tool_env(
                    renderer=renderer,
                    tools=[shell_tool.shell],
                    initial_messages=initial_messages,
                    reward_fn=MirageVerifier(rollout),
                    model_name=self.model_name,
                    max_turns=self.max_turns,
                    max_trajectory_tokens=self.max_trajectory_tokens,
                    max_generation_tokens=self.max_generation_tokens,
                )
            )
        return envs

    async def cleanup(self) -> None:
        for rollout in self._rollouts:
            await rollout.close()
        self._rollouts.clear()

    def logging_tags(self) -> list[str]:
        return [RECIPE_NAME]
