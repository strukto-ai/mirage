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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import drive_root_empty
from mirage.core.onedrive.client import (drive_loc, graph_delete, item_url,
                                         split_path)
from mirage.types import PathSpec
from mirage.utils.errors import enotempty


async def rmdir(accessor: OneDriveAccessor,
                path: PathSpec,
                index: IndexCacheStore = NULL_INDEX) -> None:
    """Remove an empty folder.

    A Graph ``DELETE /drives/{id}/items/{item}`` removes a folder and
    everything under it, so this is the same request ``rm_r`` sends and
    the emptiness check is the only thing separating them. Without it
    ``rmdir`` destroyed the whole subtree for every caller that does not
    pre-check emptiness itself, and the command builders are the only
    callers that do: FUSE, ``ws.fs`` and the sandbox runtimes all reach
    the op directly.

    Args:
        accessor (OneDriveAccessor): OneDrive accessor.
        path (PathSpec): folder to remove.
        index (IndexCacheStore): accepted for the rmdir slot's shape;
            unused.
    """
    _, stripped = split_path(path)
    if not stripped:
        return
    loc = drive_loc(accessor.config, stripped)
    if not await drive_root_empty(accessor.config, loc, session=accessor.pool):
        raise enotempty(path)
    await graph_delete(accessor.config,
                       item_url(accessor.config, "/" + stripped),
                       session=accessor.pool)
    await invalidate_after_unlink(path)
