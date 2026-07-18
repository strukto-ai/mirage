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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.readdir import readdir
from mirage.resource.base import BaseResource
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.resource.mongodb.prompt import PROMPT
from mirage.types import ResourceName
from mirage.utils.glob_walk import make_resolve_glob

_resolve_glob = make_resolve_glob(readdir)


class MongoDBResource(BaseResource):

    accessor: MongoDBAccessor
    name: str = ResourceName.MONGODB
    caches_reads: bool = False
    PROMPT: str = PROMPT

    def __init__(self, config: MongoDBConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = MongoDBAccessor(self.config)
        from mirage.commands.builtin.mongodb import COMMANDS
        from mirage.ops.mongodb import OPS as MONGODB_VFS_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in MONGODB_VFS_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
