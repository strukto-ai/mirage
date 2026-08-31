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

from mirage.accessor.base import SessionAccessor
from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree_entry import TreeEntry


class GitHubAccessor(SessionAccessor):

    def __init__(self,
                 config: GitHubConfig,
                 owner: str,
                 repo: str,
                 ref: str | None = None,
                 default_branch: str | None = None,
                 tree: dict[str, TreeEntry] | None = None,
                 truncated: bool = False) -> None:
        super().__init__()
        self.config = config
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
        # slash, which is this mount's whole listing. find, du and grep's
        # scope counter read it straight, the way TypeScript's always
        # have: repo-relative path logic belongs on a git tree, not on an
        # index whose keys are the mount's business. Reseated by every
        # refill, so it is as fresh as the last one.
        self.tree: dict[str, TreeEntry] = tree if tree is not None else {}
        # Whether that tree is an answer or just the empty default, which
        # is not the same question as whether it holds anything: an empty
        # repository, or one holding only excluded gitlinks, hydrates to
        # {}. Reading emptiness as "not hydrated yet" made every
        # direct-tree command refetch such a repo forever, twice per call
        # once an index was wired.
        self.tree_loaded: bool = tree is not None
        self.truncated = truncated
