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

from mirage.accessor.email import EmailAccessor
from mirage.commands.builtin.email import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.email.config import EmailConfig
from mirage.ops.email import OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.email.prompt import PROMPT, WRITE_PROMPT


class EmailVFS(BaseVFS):

    accessor: EmailAccessor
    name: str = VFSName.EMAIL
    caches_reads: bool = True
    # Every listed file carries an exact size: .email.json is rendered at
    # readdir from the full BODY.PEEK[] the listing already fetches, and an
    # attachment's size is its decoded payload length.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: EmailConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = EmailAccessor(config)

    def ops(self) -> list[RegisteredOp]:
        return OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
