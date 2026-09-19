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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.commands.builtin.lancedb import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.lancedb import OPS as LANCEDB_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.lancedb.config import LanceDBConfig
from mirage.vfs.lancedb.prompt import PROMPT

_REMOTE_SCHEMES = ("s3://", "gs://", "az://", "hf://", "db://")


class LanceDBVFS(BaseVFS):

    accessor: LanceDBAccessor
    name: str = VFSName.LANCEDB
    # readdir seeds exact card sizes from the widened select and stat falls
    # back to rendering the row itself, so sizes are exact either way.
    sizes_always_known: bool = True
    # A live store: every readdir must hit the backend, so the index is
    # not reused across commands. Mirrors the TypeScript VFS.
    index_ttl: float = 0
    prompt: str = PROMPT

    def __init__(self, config: LanceDBConfig) -> None:
        super().__init__()
        self.config = config
        self.caches_reads = config.uri.startswith(_REMOTE_SCHEMES)
        self.accessor = LanceDBAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return LANCEDB_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
