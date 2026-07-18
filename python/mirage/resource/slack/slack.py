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

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.glob import resolve_glob as _resolve_glob
from mirage.resource.base import BaseResource
from mirage.resource.slack.config import SlackConfig
from mirage.resource.slack.prompt import PROMPT, WRITE_PROMPT
from mirage.types import ResourceName


class SlackResource(BaseResource):

    accessor: SlackAccessor
    name: str = ResourceName.SLACK
    caches_reads: bool = True
    PROMPT: str = PROMPT
    WRITE_PROMPT: str = WRITE_PROMPT

    def __init__(self, config: SlackConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SlackAccessor(self.config)
        from mirage.commands.builtin.slack import COMMANDS
        from mirage.ops.slack import OPS as SLACK_VFS_OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in SLACK_VFS_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
