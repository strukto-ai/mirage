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
from mirage.core.onedrive._client import (GraphError, graph_delete, item_url,
                                          split_path)
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: OneDriveAccessor, path: PathSpec) -> None:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    try:
        await graph_delete(accessor.config,
                           item_url(accessor.config, "/" + stripped))
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    await invalidate_after_unlink(path)
