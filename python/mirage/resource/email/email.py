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
from mirage.core.email.readdir import readdir
from mirage.resource.base import BaseResource
from mirage.resource.email.config import EmailConfig
from mirage.resource.email.prompt import PROMPT, WRITE_PROMPT
from mirage.types import ResourceName
from mirage.utils.glob_walk import make_resolve_glob

_resolve_glob = make_resolve_glob(readdir)


class EmailResource(BaseResource):

    accessor: EmailAccessor
    name: str = ResourceName.EMAIL
    caches_reads: bool = True
    PROMPT: str = PROMPT
    WRITE_PROMPT: str = WRITE_PROMPT

    def __init__(self, config: EmailConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = EmailAccessor(config)
        from mirage.commands.builtin.email import COMMANDS
        from mirage.ops.email import OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
