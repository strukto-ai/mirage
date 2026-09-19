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

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.ram import OPS as RAM_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram.prompt import PROMPT
from mirage.vfs.ram.store import RAMStore


class RAMVFS(BaseVFS):

    accessor: RAMAccessor
    name: str = VFSName.RAM
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    index_ttl: float = 0
    prompt: str = PROMPT

    def __init__(self) -> None:
        super().__init__()
        self._store = RAMStore()
        self.accessor = RAMAccessor(self._store)

    def ops(self) -> list[RegisteredOp]:
        return RAM_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(RAM_COMMANDS)

    def get_state(self) -> dict[str, Any]:
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

    def load_state(self, state: dict[str, Any]) -> None:
        self._store.files = dict(state.get("files", {}))
        self._store.dirs = set(state.get("dirs", ["/"]))
        self._store.modified = dict(state.get("modified", {}))
        self._store.attrs = {
            k: dict(v)
            for k, v in state.get("attrs", {}).items()
        }
