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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.core.jaeger.read import read as _read
from mirage.core.jaeger.readdir import readdir as _readdir
from mirage.core.jaeger.stat import stat as _stat
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.jaeger.config import JaegerConfig

VFS_MD = """\
{prefix}
  services/
    <service-name>/
      operations.json
      traces/
        <trace-id>.json"""


class JaegerVFS(BaseVFS):
    accessor: JaegerAccessor
    name: str = VFSName.JAEGER
    caches_reads: bool = True
    # Every listed file carries an exact size: a trace is rendered at readdir
    # from the search payload the listing already fetched, and operations.json
    # is sized by one call per service directory the caller opens.
    sizes_always_known: bool = True
    vfs_md: str = VFS_MD

    def __init__(self, config: JaegerConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = JaegerAccessor(self.config)

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
