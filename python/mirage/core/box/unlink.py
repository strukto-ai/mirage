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

from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import (
    delete_condition,
    invalidate_after_unlink,
    native_condition,
)
from mirage.core.box.api import delete_file, refused
from mirage.core.box.client import BoxApiError
from mirage.core.box.fingerprint import live_of
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec


async def delete_resolved(
    accessor: BoxAccessor, path: PathSpec, item: dict[str, Any]
) -> None:
    """Delete a resolved file, held to the version read, else the one found.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the file's path.
        item (dict[str, Any]): the file as the lookup found it.
    """
    live = live_of(item)
    cond = await delete_condition(path, live.content if live else None)
    etag = await native_condition(path, cond, live, "delete")
    try:
        await delete_file(accessor.token_manager, item["id"], etag)
    except BoxApiError as exc:
        raise (await refused(path, exc, cond, etag)) or exc


async def unlink(accessor: BoxAccessor, path: PathSpec) -> None:
    parts = path_parts(path)
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    if item.get("type") == "folder":
        raise eisdir(path.virtual)
    upto = lost_count()
    timer = start_op()
    await delete_resolved(accessor, path, item)
    record("unlink", path.virtual, "box", 0, timer)
    await invalidate_after_unlink(path)
    lift_lost(path, upto)
