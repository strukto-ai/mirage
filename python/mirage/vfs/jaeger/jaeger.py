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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.commands.builtin.jaeger import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.jaeger import OPS as JAEGER_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.jaeger.config import JaegerConfig
from mirage.vfs.jaeger.prompt import PROMPT


class JaegerVFS(BaseVFS):

    accessor: JaegerAccessor
    name: str = VFSName.JAEGER
    caches_reads: bool = True
    # Every listed file carries an exact size: a trace is rendered at readdir
    # from the search payload the listing already fetched, and operations.json
    # is sized by one call per service directory the caller opens.
    sizes_always_known: bool = True
    prompt: str = PROMPT

    def __init__(self, config: JaegerConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = JaegerAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return JAEGER_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
