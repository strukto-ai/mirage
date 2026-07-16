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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.core.github_ci.glob import resolve_glob as _resolve_glob
from mirage.resource.base import BaseResource
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.resource.github_ci.prompt import PROMPT
from mirage.types import ResourceName


class GitHubCIResource(BaseResource):

    accessor: GitHubCIAccessor
    name: str = ResourceName.GITHUB_CI
    caches_reads: bool = True
    PROMPT: str = PROMPT

    def __init__(self, config: GitHubCIConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GitHubCIAccessor(self.config)
        from mirage.commands.builtin.github_ci import COMMANDS
        from mirage.ops.github_ci import OPS

        for fn in COMMANDS:
            self.register(fn)
        for fn in OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    async def fingerprint(self, path: str) -> str | None:
        lookup = await self._index.get(path)
        return lookup.entry.remote_time if lookup.entry else None

    def get_state(self) -> dict:
        return self.config_state(self.config)

    def load_state(self, state: dict) -> None:
        pass
