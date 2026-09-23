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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.tree import fetch_tree
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook


class HfHubWalk:
    """One tree fetch feeding the generic listing differ.

    The Hub's listing endpoint is recursive, so a pull is one paged walk
    whatever the repository's shape, and the fingerprint is the git
    object id: git is content-addressed, so identical bytes carry an
    identical oid and a rewrite that changed nothing correctly reports
    nothing.

    A mount reads one revision, so what this detects is that revision
    moving. Nothing is reported while the branch sits still, however much
    is pushed elsewhere in the repository.
    """

    def __init__(self, accessor: HfHubAccessor) -> None:
        """Args:
            accessor (HfHubAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).

        Yields:
            WalkEntry: one row per path in the repository subtree.
        """
        accessor = self._accessor
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        tree = await fetch_tree(accessor)
        # The tree just fetched is exactly what the accessor holds, and
        # find, du and every no-index read consult it. Discarding it here
        # would leave them answering from the pre-pull listing, so a pull
        # that reported a CREATE would be followed by a find that could
        # not see the file.
        accessor.tree = tree
        accessor.tree_loaded = True
        accessor.rows_cache = None
        stem = root.mount_path.strip("/")
        base = (stem + "/") if stem else ""
        for entry in tree.values():
            if base and not entry.path.startswith(base):
                continue
            virtual = (prefix.rstrip("/") + "/" +
                       entry.path if prefix else "/" + entry.path)
            if entry.is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=entry.oid,
                            size=entry.size)


def build_delta_hook(accessor: HfHubAccessor) -> DeltaHook:
    """Build the Hub delta hook.

    Args:
        accessor (HfHubAccessor): Backend handle.
    """
    return ListingDeltaHook(HfHubWalk(accessor))
