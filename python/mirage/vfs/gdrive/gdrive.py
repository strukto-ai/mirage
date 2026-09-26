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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.commands.builtin.gdrive import COMMANDS
from mirage.commands.builtin.gdrive.io import IO
from mirage.core.gdrive.watch import build_delta_hook
from mirage.core.google.client import TokenManager
from mirage.ops.gdrive import OPS as GDRIVE_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.gdrive.config import GoogleDriveConfig
from mirage.vfs.gdrive.prompt import PROMPT
from mirage.watch.base import DeltaHook


class GoogleDriveVFS(BoundVFS):

    accessor: GDriveAccessor
    name: str = VFSName.GDRIVE
    caches_reads: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True
    READ_REVALIDATABLE: bool = True

    def __init__(self, config: GoogleDriveConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GDriveAccessor(self.config, self._token_manager)
        for fn in COMMANDS:
            self.register(fn)
        for op in GDRIVE_VFS_OPS:
            self.register_op(op)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
