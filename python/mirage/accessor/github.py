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

    def join(self, peers: Iterable[Accessor]) -> None:
        """Ride the pool of a peer account (a gh install's, or a github
        mount's) on the same token and API base.

        Args:
            peers (Iterable[Accessor]): the workspace's other accessors.
        """
        token = self.config.token.get_secret_value()
        for peer in peers:
            account = (
                peer.account if isinstance(peer, GitHubAccessor) else peer
            )
            if (
                isinstance(account, GitHubAccount)
                and account is not self
                and account.config.token.get_secret_value() == token
                and account.config.base_url == self.config.base_url
            ):
                self.share(account)
                return


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
        # The head commit that tree was fetched at, as the response named
        # it, or None when it is not known (a tree handed in, a truncated
        # or sha-less response). Every listing out of the tree carries it
        # as its version.
        self.tree_version: str | None = None

    async def close(self) -> None:
        await self.account.close()
