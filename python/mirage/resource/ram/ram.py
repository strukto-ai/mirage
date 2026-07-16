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

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.core.ram.append import append_bytes
from mirage.core.ram.copy import copy
from mirage.core.ram.create import create
from mirage.core.ram.du import du, du_all
from mirage.core.ram.exists import exists
from mirage.core.ram.find import find
from mirage.core.ram.glob import resolve_glob as _resolve_glob
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read_bytes
from mirage.core.ram.readdir import readdir
from mirage.core.ram.rename import rename
from mirage.core.ram.rm import rm_r
from mirage.core.ram.rmdir import rmdir
from mirage.core.ram.stat import stat as ram_stat
from mirage.core.ram.stream import read_stream
from mirage.core.ram.truncate import truncate
from mirage.core.ram.unlink import unlink
from mirage.core.ram.write import write_bytes
from mirage.ops.ram import OPS as RAM_OPS
from mirage.resource.base import BaseResource
from mirage.resource.ram.prompt import PROMPT
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_RAM_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": ram_stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
    "mkdir": mkdir,
    "read_stream": read_stream,
    "rm_recursive": rm_r,
    "du_total": du,
    "du_all": du_all,
    "create": create,
    "truncate": truncate,
    "exists": exists,
    "find_flat": find,
    "append": append_bytes,
}


class RAMResource(BaseResource):

    accessor: RAMAccessor
    name: str = ResourceName.RAM
    index_ttl: float = 0
    _ops: dict = _RAM_OPS
    PROMPT: str = PROMPT

    def __init__(self) -> None:
        super().__init__()
        self._store = RAMStore()
        self.accessor = RAMAccessor(self._store)
        for fn in RAM_COMMANDS:
            self.register(fn)
        for fn in RAM_OPS:
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
        return {
            "type": self.name,
            "files": dict(self._store.files),
            "dirs": list(self._store.dirs),
            "modified": dict(self._store.modified),
            "attrs": {
                k: dict(v)
                for k, v in self._store.attrs.items()
            },
        }

    def load_state(self, state: dict) -> None:
        self._store.files = dict(state.get("files", {}))
        self._store.dirs = set(state.get("dirs", ["/"]))
        self._store.modified = dict(state.get("modified", {}))
        self._store.attrs = {
            k: dict(v)
            for k, v in state.get("attrs", {}).items()
        }
