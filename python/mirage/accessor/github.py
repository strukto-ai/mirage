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

import asyncio
from collections.abc import Iterable

from mirage.accessor.base import Accessor, SessionAccessor
from mirage.core.github.config import GhConfig
from mirage.core.github.constants import API_BASE
from mirage.core.github.tree_entry import TreeEntry


class GitHubAccount(SessionAccessor):
    """One GitHub account: token, API base and the pool its calls ride.

    A gh install's accessor, and the account a github mount holds.

    Args:
        config (GhConfig): the token and API base; a gh install's also
            names its default repository and branch.
    """

    def __init__(self, config: GhConfig) -> None:
        super().__init__()
        self.config = config

    @property
    def api_base(self) -> str:
        """The REST base its calls go to: github.com's when none is set."""
        return (self.config.base_url or API_BASE).rstrip("/")

    def _peer(self, peer: Accessor) -> "GitHubAccount | None":
        """The account behind a peer (a gh install's, or a github
        mount's) on this API base; None for any other.

        Args:
            peer (Accessor): another of the workspace's accessors.
        """
        account = peer.account if isinstance(peer, GitHubAccessor) else peer
        if (
            isinstance(account, GitHubAccount)
            and account.api_base == self.api_base
        ):
            return account
        return None

    def join(self, peers: Iterable[Accessor]) -> None:
        """Ride the pool of a peer account on the same token and API base.

        Args:
            peers (Iterable[Accessor]): the workspace's other accessors.
        """
        token = self.config.token.get_secret_value()
        for peer in peers:
            account = self._peer(peer)
            if (
                account is not None
                and account is not self
                and account.config.token.get_secret_value() == token
            ):
                self.share(account)
                return

    def reaches(self, peer: Accessor) -> bool:
        """Whether a write through this account may change what ``peer``
        reads: only a GitHub account or repository on the same API base,
        whatever token it reads with, since two tokens can reach one
        repository.

        Args:
            peer (Accessor): another of the workspace's accessors.
        """
        return self._peer(peer) is not None


class GitHubAccessor(Accessor):
    """A github mount's repository, reached through the account it holds.

    Args:
        account (GitHubAccount): the account, closed with the mount.
        owner (str): the repository's owner.
        repo (str): the repository.
        ref (str | None): the pinned ref; None follows the default branch.
        default_branch (str | None): None until fetched.
        tree (dict[str, TreeEntry] | None): the recursive tree, None
            until fetched.
        truncated (bool): whether GitHub truncated that tree.
    """

    def __init__(
        self,
        account: GitHubAccount,
        owner: str,
        repo: str,
        ref: str | None = None,
        default_branch: str | None = None,
        tree: dict[str, TreeEntry] | None = None,
        truncated: bool = False,
    ) -> None:
        self.account = account
        self.owner = owner
        self.repo = repo
        # None until resolved: an unpinned mount follows the repository's
        # default branch, which costs a request to learn, so the ref is
        # settled on the first read that needs one (`ensure_ref`).
        self.ref: str | None = ref
        # None until hydrated: the mount is constructed without touching
        # the network, so the repo's default branch is fetched on the
        # first read that needs it (`ensure_default_branch`).
        self.default_branch: str | None = default_branch
        # Guard the two lazy fetches so concurrent first reads make one
        # request each rather than one per caller. Constructed outside a
        # running loop on purpose; asyncio.Lock has not bound to a loop
        # at construction since 3.10.
        self.tree_lock = asyncio.Lock()
        self.branch_lock = asyncio.Lock()
        # The recursive git tree, keyed repo-relative with no leading
        # slash, which is this mount's whole listing. grep's scope counter
        # and code search read it straight. Reseated by every listing, so
        # it is as fresh as the last one.
        self.tree: dict[str, TreeEntry] = tree if tree is not None else {}
        # Whether that tree is an answer or just the empty default, which
        # is not the same question as whether it holds anything: an empty
        # repository, or one holding only excluded gitlinks, hydrates to
        # {}. Reading emptiness as "not hydrated yet" made every
        # direct-tree command refetch such a repo forever, twice per call
        # once an index was wired.
        self.tree_loaded: bool = tree is not None
        self.truncated = truncated

    async def close(self) -> None:
        await self.account.close()

    def forget(self) -> None:
        """Drop the tree with the mount's caches, so the next listing
        fetches it again."""
        super().forget()
        self.tree = {}
        self.tree_loaded = False
        self.truncated = False
