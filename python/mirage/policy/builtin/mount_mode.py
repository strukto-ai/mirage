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

from mirage.context.session_context import require_paths_writable
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition, ReadOnlyError
from mirage.policy.base import Policy
from mirage.policy.types import Deny, VfsContext


class MountModePolicy(Policy):
    """The configured mode and session grants bound every mutation.

    An op outside every mount carries an empty prefix and is governed
    by ``/``, the turf a profile's root mode is written under.
    """

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if not ctx.write or ctx.mode is None:
            return None
        try:
            require_paths_writable(
                [ctx.path], ctx.prefix or "/", ctx.mode, subtree=ctx.subtree
            )
        except ReadOnlyError as error:
            return Deny(posix_phrase(FsCondition.EROFS), error=error)
        return None
