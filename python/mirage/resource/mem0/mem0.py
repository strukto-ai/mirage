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

from mirage.accessor.mem0 import Mem0Accessor
from mirage.commands.builtin.mem0 import COMMANDS
from mirage.commands.builtin.mem0.io import IO
from mirage.ops.mem0 import OPS as MEM0_OPS
from mirage.resource.base import BaseResource
from mirage.resource.mem0.config import Mem0Config
from mirage.resource.mem0.prompt import PROMPT
from mirage.types import PathSpec, ResourceName

_MEM0_OPS = {
    "read_bytes": IO.read_bytes,
    "read_stream": IO.read_stream,
    "readdir": IO.readdir,
    "stat": IO.stat,
}


class Mem0Resource(BaseResource):

    accessor: Mem0Accessor
    name: str = ResourceName.MEM0
    caches_reads: bool = True
    _ops = _MEM0_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: Mem0Config) -> None:
        super().__init__()
        self.config = config
        self.accessor = Mem0Accessor(self.config)
        for fn in COMMANDS:
            self.register(fn)
        for fn in MEM0_OPS:
            self.register_op(fn)

    async def resolve_glob(
        self,
        paths: list[str | PathSpec],
        prefix: str = "",
    ) -> list[PathSpec]:
        return await IO.resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
