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

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from examples.rl.constants import DEFAULT_BENCH_ROLLOUTS, DEFAULT_DATA_DIR
from examples.rl.tinker.constants import (
    DEFAULT_GROUP_SIZE,
    DEFAULT_LEARNING_RATE,
    DEFAULT_LORA_RANK,
    DEFAULT_MAX_GENERATION_TOKENS,
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TRAJECTORY_TOKENS,
    DEFAULT_MAX_TURNS,
    DEFAULT_TEMPERATURE,
    DEFAULT_TINKER_MODEL,
)
from examples.rl.tinker.schemas import RunMode


class TinkerRunConfig(BaseModel):
    """Runtime knobs for Mirage x Tinker RL benchmarks and training.

    Args:
        mode (RunMode): Execution mode: ``bench`` or ``train``.
        data_dir (Path): Root folder holding ``fixtures/`` and ``tasks/``.
        endpoints (dict[str, str]): Optional pre-running backend base URLs
            keyed by service name (e.g. ``{"github": "http://..."}``).
        rollouts (int): Concurrent synthetic rollouts in ``bench`` mode.
        model (str): Tinker model identifier for ``train`` mode.
        group_size (int): Parallel rollouts per GRPO group.
        max_steps (int): Number of RL update steps in ``train`` mode.
        max_turns (int): Maximum agent turns per episode.
        max_trajectory_tokens (int): Cumulative trajectory token cap.
        max_generation_tokens (int): Maximum tokens generated per turn.
        lora_rank (int): LoRA rank for Tinker fine-tuning.
        learning_rate (float): Optimizer learning rate for Tinker RL.
        temperature (float): Sampling temperature during rollouts.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: RunMode = "bench"
    data_dir: Path = DEFAULT_DATA_DIR
    endpoints: dict[str, str] = Field(default_factory=dict)
    rollouts: int = Field(default=DEFAULT_BENCH_ROLLOUTS, ge=1)
    model: str = DEFAULT_TINKER_MODEL
    group_size: int = Field(default=DEFAULT_GROUP_SIZE, ge=1)
    max_steps: int = Field(default=DEFAULT_MAX_STEPS, ge=1)
    max_turns: int = Field(default=DEFAULT_MAX_TURNS, ge=1)
    max_trajectory_tokens: int = Field(
        default=DEFAULT_MAX_TRAJECTORY_TOKENS, ge=512
    )
    max_generation_tokens: int = Field(
        default=DEFAULT_MAX_GENERATION_TOKENS, ge=64
    )
    lora_rank: int = Field(default=DEFAULT_LORA_RANK, ge=1)
    learning_rate: float = Field(default=DEFAULT_LEARNING_RATE, gt=0.0)
    temperature: float = Field(default=DEFAULT_TEMPERATURE, ge=0.0)
