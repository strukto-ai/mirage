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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.msgraph.client import GraphError, graph_delete
from mirage.core.sharepoint.resolve import drive_loc, resolve_item
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def unlink(accessor: SharePointAccessor, path: PathSpec) -> None:
    resolved = await resolve_item(accessor, path)
    try:
        await graph_delete(
            accessor.config,
            drive_loc(accessor.config, resolved, path.vfs_path).item(),
            session=accessor.pool,
        )
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(path)
        raise
    await invalidate_after_unlink(path)
