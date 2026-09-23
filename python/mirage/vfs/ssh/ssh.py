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
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.ssh.config import SSHConfig
from mirage.core.ssh.watch import build_delta_hook
from mirage.ops.registry import RegisteredOp
from mirage.ops.ssh import OPS as SSH_OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.ssh.prompt import PROMPT
from mirage.watch.base import DeltaHook


class SSHVFS(BaseVFS):

    accessor: SSHAccessor
    name: str = VFSName.SSH
    caches_reads: bool = True
    # SFTP stat/readdir report the remote inode's exact byte size for
    # every file; reads are the same raw bytes.
    sizes_always_known: bool = True
    # A remote filesystem: short-lived index, long enough to spare a
    # re-walk inside one command pipeline. Mirrors the TypeScript VFS.
    index_ttl: float = 60
    prompt: str = PROMPT

    def __init__(self, config: SSHConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SSHAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return SSH_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(SSH_COMMANDS)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
