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

from mirage.accessor.github import GitHubAccessor, GitHubAccount
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.github.config import GhConfig, GitHubConfig
from mirage.core.github.constants import COMMIT_SHA
from mirage.core.github.read import read as _read
from mirage.core.github.read import read_stream as _read_stream
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.search import files_containing as _files_containing
from mirage.core.github.stat import stat as _stat
from mirage.core.github.stat import tree as _tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.io.types import ByteSource
from mirage.types import (
    DirListing,
    FileStat,
    ListingVersion,
    PathSpec,
    VFSName,
)
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS


def _pin_of(ref: str | None) -> str | None:
    """The commit a ref pins every listing at, when it names one outright.

    Only a full 40- or 64-hex string can be a commit. GitHub answers shas in
    lowercase, so the pin is lowercased to compare with what it stores.
    Listings are stored at the head their tree answered, so a ref is served
    unchecked only when its listing was fetched at that sha. github.com
    refuses a branch or tag named with 40 or 64 hex characters (HTTP 422),
    so such a ref always names a commit, which cannot move; a GitHub
    Enterprise host behind ``base_url`` is assumed to refuse them too.

    Args:
        ref (str | None): the mount's effective ref.
    """
    if ref is None:
        return None
    lowered = ref.lower()
    return lowered if COMMIT_SHA.fullmatch(lowered) else None


class GitHubVFS(BaseVFS):
    accessor: GitHubAccessor
    name: str = VFSName.GITHUB
    caches_reads: bool = True
    # The git tree API reports the exact blob size for every file; the
    # blob read returns those same bytes, and submodule gitlinks (which
    # have no size and no blob) are excluded from the tree.
    sizes_always_known: bool = True
    # stat and a read both stamp the content-addressed blob sha.
    supports_snapshot: bool = True
    read_revalidatable: bool = True
    # One version covers every listing: the head commit the ref resolves
    # to, which the tree response names as its top-level sha and the root
    # stat answers with one shallow request.
    listing_version: ListingVersion = ListingVersion.MOUNT
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    whole_word_search: bool = True

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
        adding one: the first ``readdir`` fetches the whole tree anyway.

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
            raise ValueError(
                "GitHubVFS requires owner and repo, either as "
                "constructor kwargs or in GitHubConfig"
            )
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = GitHubAccessor(
            GitHubAccount(
                GhConfig(token=config.token, base_url=config.base_url)
            ),
            owner,
            repo,
            ref,
            default_branch,
            tree=tree,
            truncated=truncated,
        )
        super().__init__()
        self.listings_pin = _pin_of(ref)

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path, entry)
        data = await _read(self.accessor, path, entry)
        return slice_window(data, offset, size)

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        index: IndexCacheStore = NULL_INDEX,
    ) -> FileStat:
        return await _stat(self.accessor, path, entry, index)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path)

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
            self.config,
            owner=self.accessor.owner,
            repo=self.accessor.repo,
            ref=self.accessor.ref,
            default_branch=self.accessor.default_branch,
            truncated=self.accessor.truncated,
        )
