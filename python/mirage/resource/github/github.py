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

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexConfig, IndexEntry
from mirage.core.github.config import GitHubConfig
from mirage.core.github.readdir import readdir
from mirage.core.github.repo import fetch_default_branch_sync
from mirage.core.github.tree import fetch_tree_sync
from mirage.core.github.tree_entry import TreeEntry
from mirage.resource.base import BaseResource
from mirage.resource.github.prompt import PROMPT
from mirage.types import ResourceName
from mirage.utils.glob_walk import make_resolve_glob

_resolve_glob = make_resolve_glob(readdir)


class GitHubResource(BaseResource):

    accessor: GitHubAccessor
    name: str = ResourceName.GITHUB
    caches_reads: bool = True
    PROMPT: str = PROMPT

    def __init__(
        self,
        config: GitHubConfig,
        owner: str | None = None,
        repo: str | None = None,
        ref: str | None = None,
    ) -> None:
        super().__init__()
        owner = owner or config.owner
        repo = repo or config.repo
        ref = ref or config.ref
        if owner is None or repo is None:
            raise ValueError(
                "GitHubResource requires owner and repo, either as "
                "constructor kwargs or in GitHubConfig")
        default_branch = fetch_default_branch_sync(config, owner, repo)
        tree, truncated = fetch_tree_sync(config, owner, repo, ref)
        self.accessor = GitHubAccessor(config,
                                       owner,
                                       repo,
                                       ref,
                                       default_branch,
                                       truncated=truncated)
        self._populate_index_sync(tree)
        from mirage.commands.builtin.github import COMMANDS as _github_cmds
        from mirage.ops.github import OPS as _github_vfs_ops

        for fn in _github_cmds:
            self.register(fn)
        for fn in _github_vfs_ops:
            self.register_op(fn)

    def _populate_index_sync(self, tree: dict[str, TreeEntry]) -> None:
        dirs: dict[str, list[tuple[str, IndexEntry]]] = defaultdict(list)
        for path, entry in tree.items():
            parts = path.rsplit("/", 1)
            if len(parts) == 2:
                parent, name = "/" + parts[0], parts[1]
            else:
                parent, name = "/", parts[0]
            resource_type = "folder" if entry.type == "tree" else "file"
            idx_entry = IndexEntry(
                id=entry.sha,
                name=name,
                resource_type=resource_type,
                size=entry.size,
            )
            dirs[parent].append((name, idx_entry))
        self._github_index_entries = {
            ("/" + parent.strip("/") + "/" + name).replace("//", "/"): entry
            for parent, entries in dirs.items()
            for name, entry in entries
        }
        self._github_index_children = {
            parent:
            sorted(("/" + parent.strip("/") + "/" + name).replace("//", "/")
                   for name, _ in entries)
            for parent, entries in dirs.items()
        }
        self._github_index_expiry = (datetime.now(timezone.utc) +
                                     timedelta(days=365))
        self._seed_github_index()

    def _seed_github_index(self) -> None:
        self._index.seed(self._github_index_entries,
                         self._github_index_children,
                         self._github_index_expiry)

    def set_index(self, config: IndexConfig | None = None) -> None:
        super().set_index(config)
        if hasattr(self, "_github_index_entries"):
            self._seed_github_index()

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, self._index)

    @property
    def is_default_branch(self) -> bool:
        return self.accessor.ref == self.accessor.default_branch

    def get_state(self) -> dict[str, Any]:
        return self.config_state(
            self.accessor.config,
            owner=self.accessor.owner,
            repo=self.accessor.repo,
            ref=self.accessor.ref,
            default_branch=self.accessor.default_branch,
            truncated=self.accessor.truncated,
        )

    def load_state(self, state: dict[str, Any]) -> None:
        pass
