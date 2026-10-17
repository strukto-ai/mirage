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
from mirage.core.msgraph.client import graph_get
from mirage.core.onedrive.client import drive_base
from mirage.types import CapacityResult, CapacityState


async def capacity(accessor: OneDriveAccessor) -> CapacityResult:
    """The drive's storage quota, for df: Graph's quota facet, its
    remaining the space left. A drive without one is UNKNOWN.

    Args:
        accessor (OneDriveAccessor): backend accessor.
    """
    drive = await graph_get(
        accessor, drive_base(accessor.config), params={"$select": "quota"}
    )
    quota = drive.get("quota") or {}
    if quota.get("total") is None:
        return CapacityResult(state=CapacityState.UNKNOWN)
    total = int(quota["total"])
    used = int(quota.get("used") or 0)
    remaining = quota.get("remaining")
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=int(remaining)
        if remaining is not None
        else max(total - used, 0),
    )
