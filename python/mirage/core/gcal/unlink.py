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
from mirage.cache.index import IndexEntry
from mirage.core.gcal.client import delete_event
from mirage.core.gcal.readdir import calendar_index, readdir
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.unlink import make_unlink
from mirage.utils.errors import enoent


async def _delete(accessor: GCalAccessor, match: ScopeMatch,
                  entry: IndexEntry) -> None:
    """Delete the event the entry names, on the slotted calendar.

    The entry already carries the event id (rm resolves through the name
    the listing produced), so only the calendar's id and write role are
    looked up here.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar``.
        entry (IndexEntry): the resolved event entry.
    """
    calendars = await calendar_index(accessor)
    calendar = calendars.get(match.slots["calendar"])
    if calendar is None:
        raise enoent(match.vfs_path)
    if calendar.get("accessRole") not in ("owner", "writer"):
        raise PermissionError(match.vfs_path)
    cal_id = calendar.get("id")
    if not isinstance(cal_id, str):
        raise enoent(match.vfs_path)
    await delete_event(accessor.token_manager, cal_id, entry.id)


unlink = make_unlink(detect_scope, readdir, deleters={"event": _delete})
