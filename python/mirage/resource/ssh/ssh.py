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

from mirage.accessor.ssh import SSHAccessor
from mirage.commands.builtin.ssh import COMMANDS as SSH_COMMANDS
from mirage.core.ssh.append import append_bytes
from mirage.core.ssh.config import SSHConfig
from mirage.core.ssh.copy import copy
from mirage.core.ssh.create import create
from mirage.core.ssh.du import du, du_all
from mirage.core.ssh.exists import exists
from mirage.core.ssh.find import find
from mirage.core.ssh.glob import resolve_glob as _resolve_glob
from mirage.core.ssh.mkdir import mkdir
from mirage.core.ssh.read import read_bytes
from mirage.core.ssh.readdir import readdir
from mirage.core.ssh.rename import rename
from mirage.core.ssh.rm import rm_r
from mirage.core.ssh.rmdir import rmdir
from mirage.core.ssh.stat import stat as ssh_stat
from mirage.core.ssh.stream import range_read, read_stream
from mirage.core.ssh.truncate import truncate
from mirage.core.ssh.unlink import unlink
from mirage.core.ssh.write import write_bytes
from mirage.ops.ssh import OPS as SSH_OPS
from mirage.resource.base import BaseResource
from mirage.resource.ssh.prompt import PROMPT
from mirage.types import ResourceName

_SSH_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": ssh_stat,
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
    "append": append_bytes,
}


class SSHResource(BaseResource):

    accessor: SSHAccessor
    name: str = ResourceName.SSH
    caches_reads: bool = True
    _ops: dict[str, Any] = _SSH_OPS
    PROMPT: str = PROMPT

    def __init__(self, config: SSHConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SSHAccessor(self.config)
        for fn in SSH_COMMANDS:
            self.register(fn)
        for fn in SSH_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
