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

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict

from mirage.types import JsonValue

RunMode: TypeAlias = Literal["bench", "eval"]


@dataclass(frozen=True)
class MirageTask:
    """Harbor-compatible task executed inside a MirageOpenEnv instance.

    Args:
        task_name (str): Unique name identifying the task.
        instruction (str): Prompt handed to the agent at episode start.
        task_dir (Path): Directory holding ``environment/`` and ``tests/``.
        backends (dict[str, str]): Mapping of ``integ`` service name to
            fixture name declared under ``[backends.<service>]``.
        config (dict[str, JsonValue]): Parsed ``task.toml`` metadata.
    """

    task_name: str
    instruction: str
    task_dir: Path
    backends: dict[str, str] = field(default_factory=dict)
    config: dict[str, JsonValue] = field(default_factory=dict)


class BenchCase(BaseModel):
    """Synthetic shell commands and expected reward for local benchmarking.

    Args:
        commands (list[str]): Ordered shell turns to execute.
        expected_reward (float): Expected verifier reward at episode end.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    commands: list[str]
    expected_reward: float


class BenchFixtures(BaseModel):
    """Reference passing and failing rollout trajectories under ``tests/``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    passing: BenchCase
    failing: BenchCase


@dataclass(frozen=True)
class EpisodeMetrics:
    """Recorded metrics for one evaluated MirageOpenEnv episode.

    Args:
        task_name (str): Task evaluated in this episode.
        trial (int): Zero-based trial index for pass@k evaluation.
        reward (float): Final verifier reward.
        steps (int): Number of OpenEnv steps executed.
        refusals (int): Count of policy refusals observed during steps.
        elapsed_s (float): Wall-clock duration in seconds.
    """

    task_name: str
    trial: int
    reward: float
    steps: int
    refusals: int
    elapsed_s: float
