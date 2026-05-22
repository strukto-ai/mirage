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

from mirage.accessor.linear import LinearAccessor
from mirage.core.linear.glob import resolve_glob as _resolve_glob
from mirage.core.linear.read import read
from mirage.core.linear.readdir import readdir
from mirage.core.linear.stat import stat
from mirage.resource.base import BaseResource
from mirage.resource.linear.config import LinearConfig
from mirage.resource.linear.prompt import PROMPT, WRITE_PROMPT
from mirage.types import ResourceName

_LINEAR_OPS = {
    "read_bytes": read,
    "readdir": readdir,
    "stat": stat,
}


class LinearResource(BaseResource):

    name: str = ResourceName.LINEAR
    is_remote: bool = True
    _ops: dict = _LINEAR_OPS
    PROMPT: str = PROMPT
    WRITE_PROMPT: str = WRITE_PROMPT

    def __init__(self, config: LinearConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = LinearAccessor(self.config)
        from mirage.commands.builtin.linear import COMMANDS
        from mirage.ops.linear import OPS as LINEAR_VFS_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in LINEAR_VFS_OPS:
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
