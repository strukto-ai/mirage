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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import dropbox_rpc
from mirage.types import CapacityResult, CapacityState


async def capacity(accessor: DropboxAccessor) -> CapacityResult:
    """The account's Dropbox space, for df.

    An individual account's allocation is its own. On a team, a limit
    set for this member bounds what it may use; without one the team's
    shared allocation does.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
    """
    usage = await dropbox_rpc(
        accessor.token_manager, "/users/get_space_usage", None
    )
    allocation = usage.get("allocation") or {}
    tag = allocation.get(".tag")
    used = int(usage.get("used") or 0)
    if tag == "individual":
        total = int(allocation.get("allocated") or 0)
    elif tag == "team":
        total = int(allocation.get("user_within_team_space_allocated") or 0)
        if not total:
            total = int(allocation.get("allocated") or 0)
            used = int(allocation.get("used") or 0)
    else:
        return CapacityResult(state=CapacityState.UNKNOWN)
    if not total:
        return CapacityResult(state=CapacityState.UNKNOWN)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=max(total - used, 0),
    )
