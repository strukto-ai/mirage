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

from mirage.accessor.base import Accessor
from mirage.core.box.client import BoxTokenManager
from mirage.utils.clock import Clock
from mirage.vfs.box.config import BoxConfig


class BoxAccessor(Accessor):
    def __init__(
        self, config: BoxConfig, token_manager: BoxTokenManager
    ) -> None:
        self.config = config
        self.token_manager = token_manager

    async def close(self) -> None:
        """Drain the token manager's connection pool. Idempotent."""
        await self.token_manager.close()

    def bind_clock(self, clock: Clock) -> None:
        """Read token expiry and the upload commit's wait on the workspace's
        clock.

        Args:
            clock (Clock): the workspace's clock.
        """
        self.token_manager.bind_clock(clock)
