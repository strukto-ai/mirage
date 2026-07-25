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

import posixpath

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.msgraph.drive_ops import create_child_folder
from mirage.core.onedrive._client import item_url, split_path
from mirage.types import PathSpec


async def _create_dir(accessor: OneDriveAccessor, stripped: str) -> None:
    parent = posixpath.dirname("/" + stripped).strip("/")
    url = item_url(accessor.config,
                   "/" + parent if parent else "/",
                   action="/children")
    await create_child_folder(accessor.config, url,
                              posixpath.basename(stripped))


async def mkdir(accessor: OneDriveAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    _, stripped = split_path(path)
    if not stripped:
        return
    if parents:
        parts = stripped.split("/")
        for i in range(len(parts)):
            await _create_dir(accessor, "/".join(parts[:i + 1]))
    else:
        await _create_dir(accessor, stripped)
    await invalidate_after_write(path)
    if parents:
        await invalidate_ancestors(path)
