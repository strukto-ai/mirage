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

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.commands.builtin.gridfs import COMMANDS as GRIDFS_COMMANDS
from mirage.core.gridfs.constants import SCOPE_ERROR
from mirage.core.gridfs.copy import copy
from mirage.core.gridfs.create import create
from mirage.core.gridfs.du import du, du_all
from mirage.core.gridfs.exists import exists
from mirage.core.gridfs.find import find
from mirage.core.gridfs.mkdir import mkdir
from mirage.core.gridfs.read import read_bytes
from mirage.core.gridfs.readdir import readdir
from mirage.core.gridfs.rename import rename
from mirage.core.gridfs.rm import rm_r
from mirage.core.gridfs.rmdir import rmdir
from mirage.core.gridfs.stat import stat as gridfs_stat
from mirage.core.gridfs.stream import range_read, read_stream
from mirage.core.gridfs.truncate import truncate
from mirage.core.gridfs.unlink import unlink
from mirage.core.gridfs.write import write_bytes
from mirage.ops.gridfs import OPS as GRIDFS_OPS
from mirage.resource.base import BaseResource
from mirage.resource.gridfs.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key

_resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)

_GRIDFS_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": gridfs_stat,
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


class GridFSResource(BaseResource):

    accessor: GridFSAccessor
    name: str = ResourceName.GRIDFS
    caches_reads: bool = True
    _ops: dict[str, Any] = _GRIDFS_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: GridFSConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GridFSAccessor(self.config)
        for fn in GRIDFS_COMMANDS:
            self.register(fn)
        for fn in GRIDFS_OPS:
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
        # No-op: GridFSResource holds no local content. Reconstruction
        # happens via the resources= override at load time.
        pass
