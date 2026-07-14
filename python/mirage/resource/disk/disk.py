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
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.commands.builtin.disk import COMMANDS as DISK_COMMANDS
from mirage.core.disk.append import append_bytes
from mirage.core.disk.copy import copy
from mirage.core.disk.create import create
from mirage.core.disk.glob import resolve_glob as _resolve_glob
from mirage.core.disk.mkdir import mkdir
from mirage.core.disk.read import read_bytes
from mirage.core.disk.readdir import readdir
from mirage.core.disk.rename import rename
from mirage.core.disk.rm import rm_r
from mirage.core.disk.rmdir import rmdir
from mirage.core.disk.stat import stat as disk_stat
from mirage.core.disk.stream import read_stream
from mirage.core.disk.truncate import truncate
from mirage.core.disk.unlink import unlink
from mirage.core.disk.write import write_bytes
from mirage.ops.disk import OPS as DISK_OPS
from mirage.resource.base import BaseResource
from mirage.resource.disk.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_DISK_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": disk_stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
    "mkdir": mkdir,
    "read_stream": read_stream,
    "rm_recursive": rm_r,
    "create": create,
    "truncate": truncate,
    "append": append_bytes,
}


class DiskResource(BaseResource):

    name: str = ResourceName.DISK
    index_ttl: float = 60
    _ops: dict = _DISK_OPS
    PROMPT: str = PROMPT

    def __init__(self, root: str) -> None:
        super().__init__()
        self.root = Path(root).resolve()
        self.accessor = DiskAccessor(self.root)
        for fn in DISK_COMMANDS:
            self.register(fn)
        for fn in DISK_OPS:
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
            remote = await disk_stat(self.accessor, path, index=self._index)
            return remote.modified
        except FileNotFoundError:
            return None

    def get_state(self) -> dict:
        files: dict[str, bytes] = {}
        for p in self.root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(self.root).as_posix()
                files[rel] = p.read_bytes()
        return {
            "type": self.name,
            "files": files,
            "attrs": {
                k: dict(v)
                for k, v in self.accessor.attrs.items()
            },
        }

    def load_state(self, state: dict) -> None:
        files = state.get("files", {})
        for rel, data in files.items():
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        self.accessor.attrs.clear()
        self.accessor.attrs.update({
            k: dict(v)
            for k, v in state.get("attrs", {}).items()
        })
