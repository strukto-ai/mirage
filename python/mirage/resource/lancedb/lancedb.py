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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.glob import resolve_glob as _resolve_glob
from mirage.resource.base import BaseResource
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.resource.lancedb.prompt import PROMPT
from mirage.types import ResourceName

_REMOTE_SCHEMES = ("s3://", "gs://", "az://", "hf://", "db://")


class LanceDBResource(BaseResource):

    accessor: LanceDBAccessor
    name: str = ResourceName.LANCEDB
    PROMPT: str = PROMPT

    def __init__(self, config: LanceDBConfig) -> None:
        super().__init__()
        self.config = config
        self.caches_reads = config.uri.startswith(_REMOTE_SCHEMES)
        self.accessor = LanceDBAccessor(self.config)
        from mirage.commands.builtin.lancedb import COMMANDS
        from mirage.ops.lancedb import OPS as LANCEDB_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in LANCEDB_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    async def fingerprint(self, path: str) -> str | None:
        return None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
