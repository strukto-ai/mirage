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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.commands.builtin.databricks_volume import \
    COMMANDS as DATABRICKS_VOLUME_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.databricks_volume import OPS as DATABRICKS_VOLUME_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.databricks_volume.config import DatabricksVolumeConfig
from mirage.vfs.databricks_volume.prompt import PROMPT


class DatabricksVolumeVFS(BaseVFS):
    accessor: DatabricksVolumeAccessor
    name: str = VFSName.DATABRICKS_VOLUME
    caches_reads: bool = True
    # The Files API lists DirectoryEntry.file_size and stat HEADs report
    # Content-Length, both the exact byte count the download returns;
    # readdir backfills any lister-omitted size with one HEAD.
    sizes_always_known: bool = True
    prompt: str = PROMPT

    def __init__(
        self,
        config: DatabricksVolumeConfig,
        client: Any | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self.accessor = DatabricksVolumeAccessor(self.config, client)

    def ops(self) -> list[RegisteredOp]:
        return DATABRICKS_VOLUME_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(DATABRICKS_VOLUME_COMMANDS)

    def get_state(self) -> dict[str, Any]:
        redacted = ["token"]
        cfg = self.config.model_dump()
        for field in redacted:
            if cfg.get(field) is not None:
                cfg[field] = "<REDACTED>"
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": redacted,
            "config": cfg,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        pass
