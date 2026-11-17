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
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.read import read as _read
from mirage.core.linear.readdir import readdir as _readdir
from mirage.core.linear.search import files_containing as _files_containing
from mirage.core.linear.stat import stat as _stat
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS

VFS_MD = """\
```text
{prefix}
  teams/
    <team-key>__<team-name>__<team-id>/
      team.json
      members/
        <display-name>__<user-id>.json
      issues/
        <issue-key>__<issue-id>/
          issue.json
          comments.jsonl
      projects/
        <name>__<project-id>.json
      cycles/
        <name>__<cycle-id>.json
      documents/
        <title>__<document-id>.json
```

- A named segment is `<sanitized-name>__<id>`; the id after the last `__`
  is exact. `ls` the parent for exact names rather than building them.
- Files are JSON normalized by Mirage with snake_case keys (`issue_key`,
  `state_name`, `assignee_email`, `label_names`), not Linear's GraphQL
  shape. `comments.jsonl` holds one comment per line.
- `team.json` lists the team's workflow states; a project file lists its
  issues with their state.
- To create, update, assign, transition or comment on issues, use the
  `linear` CLI if installed (`linear --help`)."""


class LinearVFS(BaseVFS):
    accessor: LinearAccessor
    name: str = VFSName.LINEAR
    caches_reads: bool = True
    # Every file is sized at its parent's readdir from the listing payload
    # (comments.jsonl via one bounded comments call), so stat always reports
    # the rendered byte length and fskit mounts serve exact reads.
    sizes_always_known: bool = True
    vfs_md: str = VFS_MD
    # Linear's search answers for issues; comments and the team's other
    # files are always read.
    searchable = (
        "teams/*/issues/*/issue.json",
        "teams/*/members/*",
        "teams/*/projects/*",
        "teams/*/cycles/*",
        "teams/*/documents/*",
    )

    def __init__(self, config: LinearConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = LinearAccessor(
            self.config, lambda: self.walk_limit >= 0
        )

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        return await _files_containing(
            self.accessor,
            text,
            [path],
            ask_linear=whole_word and self.walk_limit >= 0,
        )

    async def readdir(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        limit: int | None = None,
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry, limit=limit)

    async def read(
        self, path: PathSpec, parent: FileStat | None = None
    ) -> bytes:
        return await _read(self.accessor, path, None, parent)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
