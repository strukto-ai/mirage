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

from typing import Any

from mirage.accessor.gcal import GCalAccessor
from mirage.commands.builtin.gcal import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.google.client import TokenManager
from mirage.ops.gcal import OPS as GCAL_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.gcal.config import GCalConfig
from mirage.vfs.gcal.prompt import PROMPT, WRITE_PROMPT


class GCalVFS(BaseVFS):

    accessor: GCalAccessor
    name: str = VFSName.GCAL
    caches_reads: bool = True
    # Shorter than the other Google mounts: a calendar is edited by other
    # people and a day-long index would keep serving a schedule that has
    # already moved.
    index_ttl: float = 300
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: GCalConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GCalAccessor(self.config, self._token_manager)

    def ops(self) -> list[RegisteredOp]:
        return GCAL_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
