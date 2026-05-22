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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.glob import resolve_glob as _resolve_glob
from mirage.core.google._client import TokenManager
from mirage.resource.base import BaseResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.gdrive.prompt import PROMPT
from mirage.types import ResourceName


class GoogleDriveResource(BaseResource):

    name: str = ResourceName.GDRIVE
    is_remote: bool = True
    PROMPT: str = PROMPT

    def __init__(self, config: GoogleDriveConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GDriveAccessor(self.config, self._token_manager)
        from mirage.commands.builtin.gdrive import COMMANDS
        from mirage.ops.gdrive import OPS as GDRIVE_VFS_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in GDRIVE_VFS_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    async def fingerprint(self, path: str) -> str | None:
        lookup = await self._index.get(path)
        return lookup.entry.remote_time if lookup.entry else None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
