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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.resolve import root_context
from mirage.core.google.client import drive_base, google_get
from mirage.types import CapacityResult, CapacityState


async def capacity(accessor: GDriveAccessor) -> CapacityResult:
    """The account's Drive storage quota, for df.

    A mount rooted in a shared drive is UNKNOWN: its files count against
    the organization's pool, which no one account's quota describes. An
    account Drive reports no limit for has unlimited storage, ELASTIC.

    Args:
        accessor (GDriveAccessor): backend accessor.
    """
    _, shared = await root_context(accessor)
    if shared:
        return CapacityResult(state=CapacityState.UNKNOWN)
    tm = accessor.token_manager
    about = await google_get(
        tm, f"{drive_base(tm)}/about", params={"fields": "storageQuota"}
    )
    quota = about.get("storageQuota") or {}
    if quota.get("limit") is None:
        return CapacityResult(state=CapacityState.ELASTIC)
    total = int(quota["limit"])
    used = int(quota.get("usage") or 0)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=max(total - used, 0),
    )
