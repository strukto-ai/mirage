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

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.onedrive._client import (GraphError, drive_ref_path,
                                          graph_delete, graph_get, graph_list,
                                          graph_patch, item_url, split_path)
from mirage.types import PathSpec


def _move_body(config: OneDriveConfig, src_s: str, dst_s: str) -> dict:
    src_parent = posixpath.dirname("/" + src_s).strip("/")
    dst_parent = posixpath.dirname("/" + dst_s).strip("/")
    body: dict = {"name": posixpath.basename(dst_s)}
    if dst_parent != src_parent:
        body["parentReference"] = {"path": drive_ref_path(config, dst_parent)}
    return body


async def rename(accessor: OneDriveAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    _, src_s = split_path(src)
    _, dst_s = split_path(dst)
    config = accessor.config
    body = _move_body(config, src_s, dst_s)
    try:
        await graph_patch(config, item_url(config, "/" + src_s), body)
    except GraphError as exc:
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise
        # GNU mv overwrites the destination, but a Graph move has no
        # conflictBehavior that works across account types: drop the
        # conflicting file (or empty folder) and retry. A non-empty
        # folder conflict keeps the original error, mirroring mv's
        # "Directory not empty".
        dst_item = await graph_get(config, item_url(config, "/" + dst_s))
        if "folder" in dst_item:
            children = await graph_list(
                config, item_url(config, "/" + dst_s, action="/children"))
            if children:
                raise
        await graph_delete(config, item_url(config, "/" + dst_s))
        await graph_patch(config, item_url(config, "/" + src_s), body)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
