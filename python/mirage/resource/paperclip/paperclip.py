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

from mirage.accessor.paperclip import PaperclipAccessor
from mirage.core.paperclip.glob import resolve_glob as _resolve_glob
from mirage.resource.base import BaseResource
from mirage.resource.paperclip.config import PaperclipConfig
from mirage.resource.paperclip.prompt import PROMPT
from mirage.types import ResourceName


class PaperclipResource(BaseResource):

    name: str = ResourceName.PAPERCLIP
    is_remote: bool = True
    PROMPT: str = PROMPT

    def __init__(self, config: PaperclipConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = PaperclipAccessor(self.config)
        from mirage.ops.paperclip import OPS as PAPERCLIP_VFS_OPS

        for fn in PAPERCLIP_VFS_OPS:
            self.register_op(fn)
        from mirage.commands.builtin.paperclip import COMMANDS

        for fn in COMMANDS:
            self.register(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    async def fingerprint(self, path: str) -> str | None:
        lookup = await self._index.get(path)
        return lookup.entry.remote_time if lookup.entry else None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
