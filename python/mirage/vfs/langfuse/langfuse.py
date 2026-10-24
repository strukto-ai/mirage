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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.core.langfuse.read import read as _read
from mirage.core.langfuse.readdir import readdir as _readdir
from mirage.core.langfuse.stat import stat as _stat
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.langfuse.config import LangfuseConfig

VFS_MD = """\
{prefix}
  traces/
    <trace-id>.json
  sessions/
    <session-id>/
      <trace-id>.json
  prompts/
    <prompt-name>/
      <version>.json
  datasets/
    <dataset-name>/
      items.jsonl
      runs/
        <run-name>.jsonl"""


class LangfuseVFS(BaseVFS):
    accessor: LangfuseAccessor
    name: str = VFSName.LANGFUSE
    caches_reads: bool = True
    vfs_md: str = VFS_MD

    def __init__(self, config: LangfuseConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = LangfuseAccessor(self.config)

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read(self, path: PathSpec) -> bytes:
        return await _read(self.accessor, path)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
