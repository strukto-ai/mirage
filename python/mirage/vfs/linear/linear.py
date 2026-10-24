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
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS

VFS_MD = """\
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
  Always ls directories first to discover exact names.

  Folder/file name anatomy: every entity-named segment is
    <sanitized-human-readable>__<id>
  The human-readable part is sanitized — don't construct it; ls the
  parent dir to discover exact entry names.
  IDs are the LAST "__"-separated segment. To extract:
    {prefix}/teams/STR__Strukto-ai__<team-id>/             -> <team-id>
    {prefix}/teams/.../issues/STR-42__<issue-id>/          -> <issue-id>
    {prefix}/teams/.../members/Alice__<user-id>.json       -> <user-id>

  All cat output is mirage-normalized (snake_case keys), NOT the raw
  Linear GraphQL response. Shapes:

  team.json:
    {
      "team_id": "...", "team_key": "STR", "team_name": "Strukto",
      "name": "...", "description": "...", "timezone": "...",
      "updated_at": "...",
      "states": [
        { "state_id": "...", "state_name": "Todo", "type": "unstarted" },
        ...                              # one element per workflow state
      ]
    }

  issue.json:
    {
      "issue_id": "...", "issue_key": "STR-42",
      "title": "...", "description": "...",
      "team_id": "...", "team_key": "...", "team_name": "...",
      "project_id": "...",   "project_name": "...",
      "cycle_id": "...",     "cycle_name": "...",   "cycle_number": 7,
      "state_id": "...",     "state_name": "In Progress",
      "assignee_id": "...",  "assignee_email": "...", "assignee_name": "...",
      "creator_id":  "...",  "creator_email":  "...", "creator_name":  "...",
      "priority": 2,         # 0=none 1=urgent 2=high 3=medium 4=low
      "label_ids":   ["..."],
      "label_names": ["bug", "frontend"],
      "created_at": "...", "updated_at": "...", "url": "..."
    }

  comments.jsonl:                      # one normalized comment per line
    { "comment_id": "...", "issue_id": "...", "issue_key": "STR-42",
      "user_id": "...", "user_email": "...", "user_name": "...",
      "body": "...", "created_at": "...", "updated_at": "...",
      "url": "..." }

  project.json:
    {
      "project_id": "...", "team_id": "...",
      "name": "...", "description": "...", "state": "started",
      "lead_id": "...", "updated_at": "...", "url": "...",
      "issue_count": 12,
      "issues": [
        { "issue_id": "...", "issue_key": "STR-42", "title": "...",
          "state_id": "...", "state_name": "In Progress", "url": "..." }
      ]
    }

  cycle.json:
    {
      "cycle_id": "...", "team_id": "...",
      "name": "...", "number": 7,
      "starts_at": "...", "ends_at": "...",
      "updated_at": "...", "url": "..."
    }

  user.json:
    {
      "user_id": "...", "name": "...", "display_name": "...",
      "email": "...", "is_active": true, "is_admin": false,
      "updated_at": "...", "url": "..."
    }

  Useful jq paths:
    .issue_key                              # issue.json
    .state_name                             # issue.json
    .assignee_email                         # issue.json
    .label_names[]                          # issue.json
    .issues[] | select(.state_name == "In Progress")   # project.json
    .states[].state_name                    # team.json
    [inputs] | length                       # comments.jsonl: count
    [inputs | select(.user_email == "x")] | length     # comments.jsonl

  document.json:
    {
      "document_id": "...", "title": "...", "content": "...",
      "project_id": "...", "project_name": "...",
      "creator_id": "...", "creator_name": "...", "creator_email": "...",
      "created_at": "...", "updated_at": "...", "url": "..."
    }

  To act on issues (list/get/create/update/assign/transition,
  comments, projects, cycles, labels, users, documents, search), use
  the linear CLI if installed: linear --help"""


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
        self.walk_limit = config.walk_limit
        self.accessor = LinearAccessor(self.config)

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
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        parent: FileStat | None = None,
    ) -> bytes:
        data = await _read(self.accessor, path, None, parent)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
