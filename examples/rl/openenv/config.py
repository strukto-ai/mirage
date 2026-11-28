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
from examples.rl.openenv.constants import (
    DEFAULT_ACTION_TIMEOUT,
    DEFAULT_CONCURRENCY,
    DEFAULT_EVAL_MODEL,
    DEFAULT_MAX_STEPS,
    DEFAULT_TRIALS,
)
from examples.rl.openenv.schemas import RunMode


class OpenEnvRunConfig(BaseModel):
    """Runtime knobs for MirageOpenEnv benchmarks and LLM evaluations.

    Args:
        mode (RunMode): Execution mode: ``bench`` or ``eval``.
        data_dir (Path): Root folder holding ``fixtures/`` and ``tasks/``.
        endpoints (dict[str, str]): Optional pre-running backend base URLs
            keyed by service name (e.g. ``{"github": "http://..."}``).
        rollouts (int): Concurrent synthetic rollouts in ``bench`` mode.
        model (str): Model identifier queried in ``eval`` mode.
        base_url (str | None): Optional OpenAI-compatible API base URL.
        api_key (str | None): Optional API key for ``eval`` mode.
        trials (int): Episodes evaluated per task (for pass@k).
        concurrency (int): Max concurrent episodes during ``eval`` mode.
        max_steps (int): Maximum OpenEnv tool steps per episode.
        action_timeout_s (float): Timeout in seconds per OpenEnv step.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: RunMode = "bench"
    data_dir: Path = DEFAULT_DATA_DIR
    endpoints: dict[str, str] = Field(default_factory=dict)
    rollouts: int = Field(default=DEFAULT_BENCH_ROLLOUTS, ge=1)
    model: str = DEFAULT_EVAL_MODEL
    base_url: str | None = None
    api_key: str | None = None
    trials: int = Field(default=DEFAULT_TRIALS, ge=1)
    concurrency: int = Field(default=DEFAULT_CONCURRENCY, ge=1)
    max_steps: int = Field(default=DEFAULT_MAX_STEPS, ge=1)
    action_timeout_s: float = Field(default=DEFAULT_ACTION_TIMEOUT, gt=0.0)
