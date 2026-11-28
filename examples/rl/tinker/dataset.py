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

import chz
from tinker_cookbook.rl.types import (
    EnvGroupBuilder,
    RLDataset,
    RLDatasetBuilder,
)

from examples.rl.schemas import MirageTask
from examples.rl.server import ServerPool
from examples.rl.tinker.constants import (
    DEFAULT_MAX_TRAJECTORY_TOKENS,
    DEFAULT_MAX_TURNS,
)
from examples.rl.tinker.environment import MirageEnvGroupBuilder


class MirageDataset(RLDataset):
    """Batched RLDataset yielding MirageEnvGroupBuilder groups.

    Args:
        builders (list[MirageEnvGroupBuilder]): Builders for each task.
        batch_size (int): Number of task groups per batch.
    """

    def __init__(
        self, builders: list[MirageEnvGroupBuilder], batch_size: int
    ) -> None:
        self.builders = builders
        self.batch_size = batch_size

    def get_batch(self, index: int) -> Sequence[EnvGroupBuilder]:
        start = index * self.batch_size
        return self.builders[start : start + self.batch_size]

    def __len__(self) -> int:
        return (len(self.builders) + self.batch_size - 1) // self.batch_size


@chz.chz
class MirageDatasetBuilder(RLDatasetBuilder):
    """RLDatasetBuilder producing train and eval MirageDatasets."""

    tasks: list[MirageTask]
    servers: ServerPool
    batch_size: int
    group_size: int
    model_name: str
    renderer_name: str | None = None
    max_turns: int = DEFAULT_MAX_TURNS
    max_trajectory_tokens: int = DEFAULT_MAX_TRAJECTORY_TOKENS
    max_generation_tokens: int | None = None

    def _builders(self, group_size: int) -> list[MirageEnvGroupBuilder]:
        return [
            MirageEnvGroupBuilder(
                task=task,
                servers=self.servers,
                model_name=self.model_name,
                renderer_name=self.renderer_name,
                max_turns=self.max_turns,
                group_size=group_size,
                max_trajectory_tokens=self.max_trajectory_tokens,
                max_generation_tokens=self.max_generation_tokens,
            )
            for task in self.tasks
        ]

    async def __call__(self) -> tuple[RLDataset, RLDataset | None]:
        return (
            MirageDataset(self._builders(self.group_size), self.batch_size),
            MirageDataset(self._builders(group_size=1), self.batch_size),
        )
