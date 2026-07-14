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

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.commands.builtin.onedrive import COMMANDS as ONEDRIVE_COMMANDS
from mirage.core.onedrive.copy import copy
from mirage.core.onedrive.create import create
from mirage.core.onedrive.du import du, du_all
from mirage.core.onedrive.exists import exists
from mirage.core.onedrive.find import find
from mirage.core.onedrive.glob import resolve_glob as _resolve_glob
from mirage.core.onedrive.mkdir import mkdir
from mirage.core.onedrive.read import read_bytes
from mirage.core.onedrive.readdir import readdir
from mirage.core.onedrive.rename import rename
from mirage.core.onedrive.rm import rm_r
from mirage.core.onedrive.rmdir import rmdir
from mirage.core.onedrive.stat import stat as onedrive_stat
from mirage.core.onedrive.stream import range_read, read_stream
from mirage.core.onedrive.truncate import truncate
from mirage.core.onedrive.unlink import unlink
from mirage.core.onedrive.write import write_bytes
from mirage.ops.onedrive import OPS as ONEDRIVE_OPS
from mirage.resource.base import BaseResource
from mirage.resource.onedrive.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_ONEDRIVE_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": onedrive_stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
    "mkdir": mkdir,
    "read_stream": read_stream,
    "range_read": range_read,
    "rm_recursive": rm_r,
    "du_total": du,
    "du_all": du_all,
    "create": create,
    "truncate": truncate,
    "exists": exists,
    "find_flat": find,
}


class OneDriveResource(BaseResource):

    name: str = ResourceName.ONEDRIVE
    caches_reads: bool = True
    _ops: dict[str, Any] = _ONEDRIVE_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: OneDriveConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = OneDriveAccessor(self.config)
        for fn in ONEDRIVE_COMMANDS:
            self.register(fn)
        for fn in ONEDRIVE_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    async def fingerprint(self, path: str) -> str | None:
        try:
            remote = await onedrive_stat(self.accessor,
                                         path,
                                         index=self._index)
            return remote.fingerprint
        except FileNotFoundError:
            return None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
