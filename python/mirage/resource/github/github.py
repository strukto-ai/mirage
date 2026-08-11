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
from mirage.core.github.repo import fetch_default_branch
from mirage.core.github.tree import fetch_tree
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
    # The git tree API reports the exact blob size for every file; the
    # blob read returns those same bytes, and submodule gitlinks (which
    # have no size and no blob) are excluded from the tree.
    SIZES_ALWAYS_KNOWN: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # resource.
    index_ttl: float = 86_400
    PROMPT: str = PROMPT

    def __init__(
        self,
        config: GitHubConfig,
        owner: str,
        repo: str,
        ref: str,
        default_branch: str,
        tree: dict[str, TreeEntry],
        truncated: bool = False,
    ) -> None:
        """Build the mount from a tree that has already been fetched.

        Takes the repo metadata rather than fetching it, so that
        nothing here touches the network. Use :meth:`create` unless the
        tree is already in hand.

        Args:
            config (GitHubConfig): token, base URL and defaults.
            owner (str): repository owner.
            repo (str): repository name.
            ref (str): branch, tag or commit the mount is pinned to.
            default_branch (str): the repo's default branch, for
                ``is_default_branch``.
            tree (dict[str, TreeEntry]): the recursive git tree, keyed
                by repo-relative path.
            truncated (bool): whether GitHub truncated that tree, in
                which case readdir falls back to per-directory fetches.
        """
        super().__init__()
        self.accessor = GitHubAccessor(config,
                                       owner,
                                       repo,
                                       ref,
                                       default_branch,
                                       truncated=truncated)
        self._populate_index(tree)
        from mirage.commands.builtin.github import COMMANDS as _github_cmds
        from mirage.ops.github import OPS as _github_vfs_ops

        for fn in _github_cmds:
            self.register(fn)
        for fn in _github_vfs_ops:
            self.register_op(fn)

    @classmethod
    async def build(
        cls,
        config: GitHubConfig,
        owner: str | None = None,
        repo: str | None = None,
        ref: str | None = None,
    ) -> "GitHubResource":
        """Fetch the repo's tree, then build the mount around it.

        The two GitHub round trips this needs are why construction is
        async. They used to run in ``__init__`` over a blocking
        ``urlopen``, which froze whatever event loop the caller was on —
        for the daemon that meant every other mount's in-flight I/O and
        the FUSE queue stalling for the length of a recursive-tree call.
        Mirrors the TypeScript ``GitHubResource.create``.

        Args:
            config (GitHubConfig): token, base URL and defaults.
            owner (str | None): repository owner; falls back to
                ``config.owner``.
            repo (str | None): repository name; falls back to
                ``config.repo``.
            ref (str | None): branch, tag or commit; falls back to
                ``config.ref``.

        Returns:
            GitHubResource: a mount pinned to ``ref``.

        Raises:
            ValueError: neither the kwargs nor the config name a repo.
        """
        owner = owner or config.owner
        repo = repo or config.repo
        ref = ref or config.ref
        if owner is None or repo is None:
            raise ValueError(
                "GitHubResource requires owner and repo, either as "
                "build() kwargs or in GitHubConfig")
        default_branch = await fetch_default_branch(config, owner, repo)
        tree, truncated = await fetch_tree(config, owner, repo, ref)
        return cls(config,
                   owner,
                   repo,
                   ref,
                   default_branch,
                   tree,
                   truncated=truncated)

    def _populate_index(self, tree: dict[str, TreeEntry]) -> None:
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
