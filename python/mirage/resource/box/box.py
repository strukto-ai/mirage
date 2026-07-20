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

import dataclasses
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.commands.builtin.box import COMMANDS as BOX_COMMANDS
from mirage.core.box._client import BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.core.box.readdir import readdir
from mirage.ops.box import OPS as BOX_OPS
from mirage.resource.base import BaseResource
from mirage.resource.box.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key

_resolve_glob = make_resolve_glob(readdir)


class BoxResource(BaseResource):

    accessor: BoxAccessor
    name: str = ResourceName.BOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    PROMPT: str = PROMPT

    def __init__(self, config: BoxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = BoxTokenManager(config)
        self.accessor = BoxAccessor(self.config, self._token_manager)
        for fn in BOX_COMMANDS:
            self.register(fn)
        for fn in BOX_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
