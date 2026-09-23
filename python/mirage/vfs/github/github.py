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

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.config import GitHubConfig
from mirage.core.github.readdir import readdir
from mirage.core.github.tree_entry import TreeEntry
from mirage.core.github.watch import build_delta_hook
from mirage.types import PathSpec, VFSName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.vfs.base import BaseVFS
from mirage.vfs.github.prompt import PROMPT
from mirage.watch.base import DeltaHook

_resolve_glob = make_resolve_glob(readdir)


class GitHubVFS(BaseVFS):

    accessor: GitHubAccessor
    name: str = VFSName.GITHUB
    caches_reads: bool = True
    # The git tree API reports the exact blob size for every file; the
    # blob read returns those same bytes, and submodule gitlinks (which
    # have no size and no blob) are excluded from the tree.
    SIZES_ALWAYS_KNOWN: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    PROMPT: str = PROMPT

    def __init__(
        self,
        config: GitHubConfig,
        owner: str | None = None,
        repo: str | None = None,
        ref: str | None = None,
        default_branch: str | None = None,
        tree: dict[str, TreeEntry] | None = None,
        truncated: bool = False,
    ) -> None:
        """Name the repository. Fetch nothing.

        **Do not fetch here, and do not add an async factory in front of
        this.** A constructor cannot await, so network in one means a
        blocking client, which stalls whatever event loop the caller is
        on; the daemon's ``load_workspace`` froze for two GitHub round
        trips that way. The alternative tried in 0.0.5 was to make
        :func:`mirage.vfs.registry.build_vfs` async, which
        broke every out-of-tree caller for the sake of this one backend.
        So the tree and the default branch hydrate on first use instead,
        through ``ensure_tree`` and ``ensure_default_branch``.

        Hydrating lazily also removes a wasted round trip rather than
        adding one: nothing seeds the index at build time, so the first
        ``readdir`` ran ``ensure_live_index`` and refetched the whole
        tree anyway, discarding the one fetched here.

        ``default_branch``, ``tree`` and ``truncated`` stay accepted so a
        caller holding the answers (a test, a snapshot restore) can skip
        the hydration; they are not fetched when omitted.

        Args:
            config (GitHubConfig): token, base URL and defaults.
            owner (str | None): repository owner; falls back to
                ``config.owner``.
            repo (str | None): repository name; falls back to
                ``config.repo``.
            ref (str | None): branch, tag or commit the mount is pinned
                to; falls back to ``config.ref``, and when neither names
                one the mount follows the repository's default branch,
                resolved on first read by ``ensure_ref``.
            default_branch (str | None): the repo's default branch, for
                ``is_default_branch``. Fetched on first use when None.
            tree (dict[str, TreeEntry] | None): the recursive git tree,
                keyed by repo-relative path. Fetched on first use when
                None.
            truncated (bool): whether GitHub truncated that tree, in
                which case readdir falls back to per-directory fetches.

        Raises:
            ValueError: neither the kwargs nor the config name a repo.
        """
        owner = owner or config.owner
        repo = repo or config.repo
        ref = ref or config.ref
        if owner is None or repo is None:
            raise ValueError("GitHubVFS requires owner and repo, either as "
                             "constructor kwargs or in GitHubConfig")
        self.accessor = GitHubAccessor(config,
                                       owner,
                                       repo,
                                       ref,
                                       default_branch,
                                       tree=tree,
                                       truncated=truncated)
        super().__init__()
        from mirage.commands.builtin.github import COMMANDS as _github_cmds
        from mirage.ops.github import OPS as _github_vfs_ops

        for fn in _github_cmds:
            self.register(fn)
        for fn in _github_vfs_ops:
            self.register_op(fn)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def resolve_glob(
        self,
        paths: list[PathSpec],
        prefix: str = '',
    ) -> list[PathSpec]:
        return await _resolve_glob(self.accessor, paths, self._index)

    @property
    def is_default_branch(self) -> bool | None:
        """Whether the mount is pinned to the repo's default branch.

        An unpinned mount answers True without a request: naming no ref
        *means* following the default branch, so the two agree whatever
        that branch turns out to be.

        Otherwise ``None`` means not known yet, not "no": the default
        branch is fetched on first use, and until something calls
        :func:`mirage.core.github.repo.ensure_default_branch` there is
        nothing to compare ``ref`` against. Answering ``False`` there
        would be a wrong answer rather than an absent one, and an
        ordinary read hydrates only the tree, so it could stay wrong for
        the life of the mount.

        Await ``ensure_default_branch(VFS.accessor)`` first when a
        definite answer is needed. Diverges from the TypeScript
        ``GitHubAccessor.isDefaultBranch``, which is always a bool
        because construction there fetches the fact.

        Returns:
            bool | None: the comparison, or None if not yet hydrated.
        """
        if self.accessor.ref is None:
            return True
        if self.accessor.default_branch is None:
            return None
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
