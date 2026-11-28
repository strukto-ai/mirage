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

from dataclasses import dataclass

from tinker_cookbook.renderers.base import Message

from examples.rl.backend import MirageRollout
from examples.rl.verifier import verify_workspace


@dataclass
class MirageVerifier:
    """Tinker reward function executing ``/tests/test.sh`` via Mirage.

    Args:
        rollout (MirageRollout): Active rollout workspace.
    """

    rollout: MirageRollout

    async def __call__(
        self, _history: list[Message]
    ) -> tuple[float, dict[str, float]]:
        ws = self.rollout.workspace
        reward = await verify_workspace(ws)
        metrics = {
            "reward": reward,
            "test_passed": float(reward > 0.0),
            "vfs_ops": float(len(ws.vfs.records)),
        }
        return reward, metrics
