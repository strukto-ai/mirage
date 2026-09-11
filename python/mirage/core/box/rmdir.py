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

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import invalidate_after_unlink, invalidate_subtree
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.api import delete_file, delete_folder
from mirage.core.box.client import BoxApiError
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir, enotempty


async def rmdir(accessor: BoxAccessor,
                path: PathSpec,
                index: IndexCacheStore = NULL_INDEX) -> None:
    parts = path_parts(path)
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    if item.get("type") != "folder":
        raise enotdir(path.virtual)
    # recursive=false: Box 409s on a non-empty folder, matching POSIX rmdir.
    # The refusal is the service's, but naming it is ours: BoxApiError is a
    # bare RuntimeError, so an unmapped 409 reached the caller as a condition
    # `classify` could not name -- EIO over FUSE, no errno at all for
    # `ws.fs` and the sandbox runtimes.
    try:
        await delete_folder(accessor.token_manager,
                            item["id"],
                            recursive=False)
    except BoxApiError as exc:
        if exc.status == 409:
            raise enotempty(path) from exc
        raise
    await invalidate_after_unlink(path)


async def rm_r(accessor: BoxAccessor, path: PathSpec) -> None:
    parts = path_parts(path)
    if not parts:
        return
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    if item.get("type") == "folder":
        await delete_folder(accessor.token_manager, item["id"], recursive=True)
    else:
        await delete_file(accessor.token_manager, item["id"])
    await invalidate_subtree(path)
