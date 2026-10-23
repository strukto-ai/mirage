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
from mirage.core.gcal.readdir import calendar_index
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.unlink import make_unlink
from mirage.errors.fs import eacces, enoent
from mirage.types import FileStat


async def _delete(
    accessor: GCalAccessor, match: ScopeMatch, entry: FileStat
) -> None:
    """Delete the event the row names, on the slotted calendar.

    The row already carries the event id (rm resolves through the name
    the listing produced), so only the calendar's id and write role are
    looked up here.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar``.
        entry (FileStat): the event's row.
    """
    calendars = await calendar_index(accessor)
    calendar = calendars.get(match.slots["calendar"])
    if calendar is None:
        raise enoent(match.vfs_path)
    if calendar.get("accessRole") not in ("owner", "writer"):
        raise eacces(match.vfs_path)
    cal_id = calendar.get("id")
    if not isinstance(cal_id, str):
        raise enoent(match.vfs_path)
    await accessor.calendar.delete_event(cal_id, str(entry.extra["event_id"]))


unlink = make_unlink(detect_scope, deleters={"event": _delete})
