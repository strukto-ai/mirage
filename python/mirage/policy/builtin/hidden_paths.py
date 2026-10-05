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

from mirage.context import hidden_refusal, path_allowed
from mirage.policy.base import Policy
from mirage.policy.types import Deny, OpsContext


class HiddenPathsPolicy(Policy):
    """Hidden paths answer as absent, including at subtree boundaries."""

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if path_allowed(ctx.path.virtual):
            return None
        error = hidden_refusal(ctx.path.virtual, ctx.create)
        return Deny(error.strerror or "No such file or directory", error=error)
