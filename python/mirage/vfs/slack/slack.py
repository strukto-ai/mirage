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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.builtin.slack import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.slack.config import SlackConfig
from mirage.ops.registry import RegisteredOp
from mirage.ops.slack import OPS as SLACK_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.slack.prompt import PROMPT, WRITE_PROMPT


class SlackVFS(BaseVFS):

    accessor: SlackAccessor
    name: str = VFSName.SLACK
    caches_reads: bool = True
    # Every listed file carries an exact size: chat.jsonl and users/*.json
    # are rendered at readdir from payloads the listing already fetched
    # (users.list is payload-identical to users.info, verified live), and
    # file blobs carry Slack's upload byte count.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: SlackConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SlackAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return SLACK_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
