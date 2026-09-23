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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.qdrant.readdir import readdir
from mirage.types import PathSpec, VFSName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.vfs.base import BaseVFS
from mirage.vfs.qdrant.config import QdrantConfig
from mirage.vfs.qdrant.prompt import PROMPT

_resolve_glob = make_resolve_glob(readdir)


class QdrantVFS(BaseVFS):

    accessor: QdrantAccessor
    name: str = VFSName.QDRANT
    # readdir seeds exact rendered sizes from the scroll payloads and stat
    # falls back to rendering the row itself, so sizes are exact either way.
    SIZES_ALWAYS_KNOWN: bool = True
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: QdrantConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = QdrantAccessor(self.config)
        from mirage.commands.builtin.qdrant import COMMANDS
        from mirage.ops.qdrant import OPS as QDRANT_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in QDRANT_OPS:
            self.register_op(fn)

    async def resolve_glob(
        self,
        paths: list[PathSpec],
        prefix: str = '',
    ) -> list[PathSpec]:
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
