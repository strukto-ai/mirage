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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.files import (append_bytes, create, exists,
                                                 mkdir, read_bytes, readdir,
                                                 rename, rm_r, rmdir, stat,
                                                 truncate, unlink, write_bytes)
from mirage.core.databricks_volume.glob import resolve_glob as _resolve_glob
from mirage.ops.databricks_volume import OPS as DATABRICKS_VOLUME_OPS
from mirage.resource.base import BaseResource
from mirage.resource.databricks_volume.config import DatabricksVolumeConfig
from mirage.resource.databricks_volume.prompt import PROMPT
from mirage.types import PathSpec, ResourceName

_DATABRICKS_VOLUME_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "append": append_bytes,
    "readdir": readdir,
    "stat": stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "rename": rename,
    "mkdir": mkdir,
    "rm_recursive": rm_r,
    "create": create,
    "truncate": truncate,
    "exists": exists,
}


def _workspace_client(config: DatabricksVolumeConfig):
    try:
        from databricks.sdk import WorkspaceClient
    except ImportError:
        raise ImportError(
            "DatabricksVolumeResource requires the 'databricks' extra. "
            "Install with: pip install mirage-ai[databricks]")
    kwargs = {}
    if config.host is not None:
        kwargs["host"] = config.host
    if config.token is not None:
        kwargs["token"] = config.token
    return WorkspaceClient(**kwargs)


class DatabricksVolumeResource(BaseResource):

    name: str = ResourceName.DATABRICKS_VOLUME
    is_remote: bool = True
    _ops: dict[str, Any] = _DATABRICKS_VOLUME_OPS
    PROMPT: str = PROMPT

    def __init__(
        self,
        config: DatabricksVolumeConfig,
        client: Any | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self.accessor = DatabricksVolumeAccessor(
            self.config,
            client if client is not None else _workspace_client(config))
        for fn in DATABRICKS_VOLUME_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p, prefix=prefix)
                if isinstance(p, PathSpec) and not p.prefix else p
                for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    async def fingerprint(self, path: str) -> str | None:
        try:
            remote = await stat(self.accessor, PathSpec.from_str_path(path))
            return remote.fingerprint
        except FileNotFoundError:
            return None

    def get_state(self) -> dict:
        redacted = ["token"]
        cfg = self.config.model_dump(by_alias=True)
        for f in redacted:
            if cfg.get(f) is not None:
                cfg[f] = "<REDACTED>"
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": redacted,
            "config": cfg,
        }

    def load_state(self, state: dict) -> None:
        pass
