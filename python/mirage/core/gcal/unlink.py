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

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gcal._client import delete_event
from mirage.core.gcal.readdir import calendar_index, normalize
from mirage.resource.gcal.event_entry import parse_event_filename
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(
    accessor: GCalAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    """Delete the event a path names.

    The path carries the event id, so no read is needed first: rm resolves
    through the name the listing already produced.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        path (PathSpec): the event file to remove.
        index (IndexCacheStore): the mount's index cache.
    """
    prefix, key, virtual_key = normalize(path)
    parts = key.split("/")
    if len(parts) != 3:
        raise IsADirectoryError(path.virtual)
    calendars = await calendar_index(accessor)
    entry = calendars.get(parts[0])
    if entry is None:
        raise enoent(path.virtual)
    role = entry.get("accessRole")
    if role not in ("owner", "writer"):
        raise PermissionError(path.virtual)
    cal_id = entry.get("id")
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    event_id, _ = parse_event_filename(parts[2])
    await delete_event(accessor.token_manager, cal_id, event_id)
    await index.invalidate_dir(virtual_key.rsplit("/", 1)[0] or "/")
    await invalidate_after_unlink(path)
