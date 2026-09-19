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

from mirage.accessor.linear import LinearAccessor
from mirage.commands.builtin.linear import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.linear.config import LinearConfig
from mirage.ops.linear import OPS as LINEAR_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.linear.prompt import PROMPT, WRITE_PROMPT


class LinearVFS(BaseVFS):

    accessor: LinearAccessor
    name: str = VFSName.LINEAR
    caches_reads: bool = True
    # Every file is sized at its parent's readdir from the listing payload
    # (comments.jsonl via one bounded comments call), so stat always reports
    # the rendered byte length and fskit mounts serve exact reads.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: LinearConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = LinearAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return LINEAR_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
