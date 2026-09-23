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

from collections.abc import Awaitable, Callable, Mapping

from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.probe import A, ReaddirFn, resolve_entry
from mirage.core.hierarchy.scope import INVALID, DetectFn, ScopeMatch
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

DeleteFn = Callable[[A, ScopeMatch, IndexEntry], Awaitable[None]]


def make_unlink(
        detect: DetectFn, readdir: ReaddirFn[A], *,
        deleters: Mapping[str, DeleteFn[A]]) -> Callable[..., Awaitable[None]]:
    """Build a hierarchy unlink: classify, resolve, delete, invalidate.

    A deleter owns only the backend delete call; classification, the
    id-resolving parent listing, the directory refusal and the cache
    invalidation happen here, identically for every backend. The match
    rides along because a delete addressed inside a container needs the
    container's slots (gcal deletes an event from a calendar), while a
    globally-id-addressed backend just ignores it.

    Args:
        detect (DetectFn): the backend's scope classifier.
        readdir (ReaddirFn): the backend's readdir, for entry resolution.
        deleters (Mapping[str, DeleteFn]): one deleter per leaf kind.
    """

    async def unlink(accessor: A,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> None:
        if index is NULL_INDEX:
            # Entry resolution reads what its parent-listing warm just
            # wrote, so a caller with no cache still needs one for the
            # duration of the call.
            index = RAMIndexCacheStore()
        match = detect(path)
        deleter = deleters.get(match.kind)
        if deleter is None:
            if match.kind != INVALID and (match.scope is None
                                          or not match.scope.leaf):
                raise IsADirectoryError(path.virtual)
            raise enoent(path)
        entry = await resolve_entry(readdir, accessor, path, index)
        if entry is None:
            raise enoent(path)
        await deleter(accessor, match, entry)
        prefix = mount_prefix_of(path.virtual, path.vfs_path)
        key = path.vfs_path.strip("/")
        virtual_key = prefix + "/" + key if key else prefix or "/"
        parent_dir = virtual_key.rsplit("/", 1)[0] or "/"
        await index.invalidate_dir(parent_dir)
        await invalidate_after_unlink(path)

    return unlink
