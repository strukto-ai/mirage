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

from constants import (
    VERIFIER_REWARD_PATH,
    VERIFIER_SCRIPT_PATH,
    VERIFIER_SESSION_ID,
)

from mirage import Workspace


async def verify_workspace(ws: Workspace) -> float:
    """Execute ``/tests/test.sh`` in the verifier session and parse reward.

    Runs inside ``VERIFIER_SESSION_ID`` so the default agent session keeps
    its working directory, environment, and hidden-path restrictions intact.

    Args:
        ws (Workspace): Active episode Mirage workspace.

    Returns:
        float: Scalar reward written to ``/logs/verifier/reward.txt``.
    """
    res = await ws.shell(
        f"sh {VERIFIER_SCRIPT_PATH}", session_id=VERIFIER_SESSION_ID
    )
    exists = await ws.vfs.exists(
        VERIFIER_REWARD_PATH, session_id=VERIFIER_SESSION_ID
    )
    if res.exit_code != 0 or not exists:
        return 0.0

    raw = await ws.vfs.read(
        VERIFIER_REWARD_PATH, session_id=VERIFIER_SESSION_ID
    )
    assert isinstance(raw, bytes)
    text = raw.decode("utf-8", errors="replace").strip()
    return float(text) if text else 0.0
