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

from backend import MirageRollout
from constants import (
    VERIFIER_PROFILE,
    VERIFIER_REWARD_PATH,
    VERIFIER_SCRIPT_PATH,
)
from tinker_cookbook.renderers.base import Message


@dataclass
class MirageVerifier:
    """Mirage-native Harbor verifier executing ``/tests/test.sh`` in-memory.

    Switches the workspace's default session to the unrestricted verifier
    profile at episode end so ``/tests`` and ``/logs/verifier`` (hidden
    during agent turns) can run and write the scalar reward.

    Args:
        rollout (MirageRollout): Active rollout workspace.
    """

    rollout: MirageRollout

    async def __call__(
        self, _history: list[Message]
    ) -> tuple[float, dict[str, float]]:
        ws = self.rollout.workspace
        await ws.set_session_profile(ws.default_session_id, VERIFIER_PROFILE)
        res = await ws.shell(f"sh {VERIFIER_SCRIPT_PATH}")
        reward = 0.0
        if res.exit_code == 0 and await ws.vfs.exists(VERIFIER_REWARD_PATH):
            raw = await ws.vfs.read(VERIFIER_REWARD_PATH)
            assert isinstance(raw, bytes)
            text = raw.decode("utf-8", errors="replace").strip()
            if text:
                reward = float(text)

        metrics = {
            "reward": reward,
            "test_passed": float(reward > 0.0),
            "vfs_ops": float(len(ws.vfs.records)),
        }
        return reward, metrics
