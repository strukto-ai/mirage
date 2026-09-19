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

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.commands.builtin.gridfs import COMMANDS as GRIDFS_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.gridfs.watch import build_delta_hook
from mirage.ops.gridfs import OPS as GRIDFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.gridfs.prompt import PROMPT
from mirage.watch.base import DeltaHook


class GridFSVFS(BaseVFS):

    accessor: GridFSAccessor
    name: str = VFSName.GRIDFS
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    caches_reads: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True

    def __init__(self, config: GridFSConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GridFSAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return GRIDFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(GRIDFS_COMMANDS)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        # No-op: GridFSVFS holds no local content. Reconstruction
        # happens via the mounts= override at load time.
        pass
