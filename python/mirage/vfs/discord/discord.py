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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.builtin.discord import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.discord.config import DiscordConfig
from mirage.ops.discord import OPS as DISCORD_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.discord.prompt import PROMPT, WRITE_PROMPT


class DiscordVFS(BaseVFS):

    accessor: DiscordAccessor
    name: str = VFSName.DISCORD
    caches_reads: bool = True
    # Every listed file carries an exact size: chat.jsonl and members/*.json
    # are rendered at readdir from payloads the listing already fetched, and
    # attachments carry Discord's CDN byte count.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: DiscordConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DiscordAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return DISCORD_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
