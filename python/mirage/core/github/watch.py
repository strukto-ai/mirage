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

from collections.abc import AsyncIterator

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree import fetch_tree
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.errors import IncompleteWalkError


class GitHubWalk:
    """One recursive git tree fetch feeding the generic listing differ.

    ``GET /git/trees/{ref}?recursive=1`` returns every path in the
    repository with its object sha, so a pull is one request whatever
    the repository's shape, and the fingerprint is the sha itself.
    That is the strongest fingerprint any mirage backend has: git is
    content-addressed, so identical bytes have an identical sha and a
    rewrite that changes nothing correctly reports nothing.

    A mount is pinned to one ref, so what this detects is that ref
    moving. Nothing is reported while the branch sits still, however
    much is pushed elsewhere in the repository.
    """

    def __init__(self, accessor: GitHubAccessor) -> None:
        """Args:
            accessor (GitHubAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).

        Raises:
            IncompleteWalkError: The repository is large enough that
                GitHub truncated the recursive tree, so the listing is
                not a complete picture of the ref and diffing it would
                report every unlisted path as deleted.
        """
        accessor = self._accessor
        prefix = mount_prefix_of(root.virtual, root.resource_path)
        ref = await ensure_ref(accessor)
        tree, truncated = await fetch_tree(accessor.config, accessor.owner,
                                           accessor.repo, ref, accessor.pool)
        if truncated:
            raise IncompleteWalkError(
                f"github tree for {accessor.owner}/{accessor.repo}"
                f"@{ref} was truncated; cannot diff a partial tree")
        # A complete tree for the ref is exactly what the accessor holds,
        # and find/du/grep's scope counter read it directly. Discarding it
        # here left them answering from the tree the mount was built with
        # until an unrelated read happened to refill the index, so a pull
        # that reported a CREATE was followed by a find that could not see
        # the file.
        accessor.tree = tree
        accessor.tree_loaded = True
        stem = root.mount_path.strip("/")
        base = (stem + "/") if stem else ""
        for entry in tree.values():
            if base and not entry.path.startswith(base):
                continue
            virtual = (prefix.rstrip("/") + "/" +
                       entry.path if prefix else "/" + entry.path)
            if entry.type == "tree":
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=entry.sha,
                            size=entry.size)


def build_delta_hook(accessor: GitHubAccessor) -> DeltaHook:
    """Build the GitHub delta hook.

    Args:
        accessor (GitHubAccessor): Backend handle.
    """
    return ListingDeltaHook(GitHubWalk(accessor))
