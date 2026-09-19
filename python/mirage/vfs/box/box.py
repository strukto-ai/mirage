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

from mirage.accessor.box import BoxAccessor
from mirage.commands.builtin.box import COMMANDS as BOX_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.core.box.watch import build_delta_hook
from mirage.ops.box import OPS as BOX_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.box.prompt import PROMPT
from mirage.watch.base import DeltaHook


class BoxVFS(BaseVFS):

    accessor: BoxAccessor
    name: str = VFSName.BOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    # Box item listings carry an exact byte `size` for every file (0
    # included); sizeless weblinks are filtered out of listings.
    sizes_always_known: bool = True
    prompt: str = PROMPT

    def __init__(self, config: BoxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = BoxTokenManager(config)
        self.accessor = BoxAccessor(self.config, self._token_manager)

    def ops(self) -> list[RegisteredOp]:
        return BOX_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(BOX_COMMANDS)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
