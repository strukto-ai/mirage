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

from mirage.accessor.hf_spaces import HfSpacesAccessor, HfSpacesConfig
from mirage.commands.builtin.hf_buckets import COMMANDS as HF_COMMANDS
from mirage.core.hf_buckets.create import create
from mirage.core.hf_buckets.du import du, du_all
from mirage.core.hf_buckets.exists import exists
from mirage.core.hf_buckets.find import find
from mirage.core.hf_buckets.glob import resolve_glob as _resolve_glob
from mirage.core.hf_buckets.mkdir import mkdir
from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_buckets.readdir import readdir
from mirage.core.hf_buckets.stat import stat as hf_stat
from mirage.core.hf_buckets.stream import range_read, read_stream
from mirage.core.hf_buckets.unlink import unlink
from mirage.core.hf_buckets.write import write_bytes
from mirage.ops.hf_buckets import OPS as HF_OPS
from mirage.resource.base import BaseResource
from mirage.resource.hf_spaces.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_OPS = {
    "read_bytes": read_bytes,
    "readdir": readdir,
    "stat": hf_stat,
    "read_stream": read_stream,
    "range_read": range_read,
    "du_total": du,
    "du_all": du_all,
    "exists": exists,
    "find_flat": find,
    "write": write_bytes,
    "create": create,
    "unlink": unlink,
    "mkdir": mkdir,
}


class HfSpacesResource(BaseResource):

    accessor: HfSpacesAccessor
    name: str = ResourceName.HF_SPACES
    caches_reads: bool = True
    _ops: dict[str, Any] = _OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: HfSpacesConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = HfSpacesAccessor(self.config)
        for fn in HF_COMMANDS:
            self.register(fn)
        for fn in HF_OPS:
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
            s = await hf_stat(self.accessor,
                              PathSpec.from_str_path(path),
                              index=self._index)
            return s.fingerprint
        except FileNotFoundError:
            return None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
