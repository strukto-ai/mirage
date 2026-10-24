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

from mirage.accessor.trello import TrelloAccessor
from mirage.core.trello.config import TrelloConfig
from mirage.core.trello.read import read as _read
from mirage.core.trello.readdir import readdir as _readdir
from mirage.core.trello.search import files_containing as _files_containing
from mirage.core.trello.stat import stat as _stat
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS

VFS_MD = """\
{prefix}
  workspaces/
    <workspace-name>__<workspace-id>/
      workspace.json
      boards/
        <board-name>__<board-id>/
          board.json
          members/
            <full-name>__<member-id>.json
          labels/
            <label-name>__<label-id>.json
          lists/
            <list-name>__<list-id>/
              list.json
              cards/
                <card-name>__<card-id>/
                  card.json
                  comments.jsonl
  Always ls directories first to discover exact names.

  To act on boards and cards (list boards, members, lists, labels,
  cards and comments; create, update, move, assign, label and comment
  on cards), use the trello CLI if installed: trello --help"""


class TrelloVFS(BaseVFS):
    accessor: TrelloAccessor
    name: str = VFSName.TRELLO
    caches_reads: bool = True
    vfs_md: str = VFS_MD
    whole_word_search: bool = True
    # Trello's search answers for cards; comments and the board's other
    # files are always read.
    searchable = ("workspaces/*/boards/*/lists/*/cards/*/card.json",)

    def __init__(self, config: TrelloConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = TrelloAccessor(self.config)

    def supports(self, name: str) -> bool:
        """Whether this VFS answers ``name``; with no walk limit it reads
        every file rather than ask the service's search.

        Args:
            name (str): the function name.
        """
        if name == "files_containing" and self.walk_limit < 0:
            return False
        return super().supports(name)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry)

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
