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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.copy import copy
from mirage.core.dropbox.mkdir import mkdir
from mirage.core.dropbox.read import read
from mirage.core.dropbox.readdir import readdir
from mirage.core.dropbox.rename import rename
from mirage.core.dropbox.rmdir import rmdir
from mirage.core.dropbox.stat import stat
from mirage.core.dropbox.unlink import unlink
from mirage.core.dropbox.write import write_bytes
from mirage.resource.base import BaseResource
from mirage.resource.dropbox.config import DropboxConfig
from mirage.resource.dropbox.prompt import PROMPT
from mirage.types import ResourceName
from mirage.utils.glob_walk import make_resolve_glob

_resolve_glob = make_resolve_glob(readdir)

_DROPBOX_OPS = {
    "read_bytes": read,
    "write": write_bytes,
    "readdir": readdir,
    "stat": stat,
    "mkdir": mkdir,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
}


class DropboxResource(BaseResource):

    accessor: DropboxAccessor
    name: str = ResourceName.DROPBOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    _ops: dict[str, Any] = _DROPBOX_OPS
    PROMPT: str = PROMPT

    def __init__(self, config: DropboxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = DropboxTokenManager(config)
        self.accessor = DropboxAccessor(config, self._token_manager)
        from mirage.commands.builtin.dropbox import COMMANDS
        from mirage.ops.dropbox import OPS as DROPBOX_VFS_OPS

        for fn in COMMANDS:
            self.register(fn)
        for op in DROPBOX_VFS_OPS:
            self.register_op(op)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
