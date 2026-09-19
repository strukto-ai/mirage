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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.commands.builtin.dropbox import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.watch import build_delta_hook
from mirage.ops.dropbox import OPS as DROPBOX_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.dropbox.config import DropboxConfig
from mirage.vfs.dropbox.prompt import PROMPT
from mirage.watch.base import DeltaHook


class DropboxVFS(BaseVFS):

    accessor: DropboxAccessor
    name: str = VFSName.DROPBOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    # list_folder carries an exact byte `size` for every file (0 included).
    # Paper docs 409 on raw download, a loud error, never a silent empty
    # read.
    sizes_always_known: bool = True
    prompt: str = PROMPT

    def __init__(self, config: DropboxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = DropboxTokenManager(config)
        self.accessor = DropboxAccessor(config, self._token_manager)

    def ops(self) -> list[RegisteredOp]:
        return DROPBOX_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

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
