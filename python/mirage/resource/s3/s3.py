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

from mirage.accessor.s3 import S3Accessor, S3Config
from mirage.commands.builtin.s3 import COMMANDS as S3_COMMANDS
from mirage.core.s3.copy import copy
from mirage.core.s3.create import create
from mirage.core.s3.du import du, du_all
from mirage.core.s3.exists import exists
from mirage.core.s3.find import find
from mirage.core.s3.glob import resolve_glob as _resolve_glob
from mirage.core.s3.mkdir import mkdir
from mirage.core.s3.read import read_bytes
from mirage.core.s3.readdir import readdir
from mirage.core.s3.rename import rename
from mirage.core.s3.rm import rm_r
from mirage.core.s3.rmdir import rmdir
from mirage.core.s3.stat import stat as s3_stat
from mirage.core.s3.stream import range_read, read_stream
from mirage.core.s3.truncate import truncate
from mirage.core.s3.unlink import unlink
from mirage.core.s3.write import write_bytes
from mirage.ops.s3 import OPS as S3_OPS
from mirage.resource.base import BaseResource
from mirage.resource.s3.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_S3_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": s3_stat,
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


class S3Resource(BaseResource):

    accessor: S3Accessor
    name: str = ResourceName.S3
    caches_reads: bool = True
    _ops: dict[str, Any] = _S3_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: S3Config) -> None:
        super().__init__()
        self.config = config
        self.accessor = S3Accessor(self.config)
        for fn in S3_COMMANDS:
            self.register(fn)
        for fn in S3_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        # No-op: S3Resource holds no local content. Reconstruction
        # happens via the resources= override at load time.
        pass
