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

from mirage.context import hidden_refusal, session_visibility
from mirage.policy.types import Hide, VfsContext
from mirage.utils.hidden import path_visible


class HiddenPathsPolicy:
    """Hidden paths answer as absent, including at subtree boundaries.

    The built-in that answers ``Hide`` at the op boundary, before any
    policy: not a ``Policy``, because no coded hook returns a Hide.
    """

    async def pre_vfs(self, ctx: VfsContext) -> Hide | None:
        """Hide the op's path when the bound session cannot see it.

        Args:
            ctx (VfsContext): the op about to run.
        """
        vis = session_visibility()
        if path_visible(vis, ctx.path):
            return None
        return Hide(hidden_refusal(vis, ctx.path, ctx.create))
