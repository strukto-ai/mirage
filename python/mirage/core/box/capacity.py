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

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import box_get
from mirage.core.box.constants import UNLIMITED_SPACE
from mirage.types import CapacityResult, CapacityState


async def capacity(accessor: BoxAccessor) -> CapacityResult:
    """The account's Box storage, for df. An unlimited account reports
    a placeholder amount, ELASTIC; one with no amount is UNKNOWN.

    Args:
        accessor (BoxAccessor): Box accessor.
    """
    tm = accessor.token_manager
    me = await box_get(
        tm,
        f"{tm.api_base}/users/me",
        params={"fields": "space_amount,space_used"},
    )
    amount = me.get("space_amount")
    if amount is None:
        return CapacityResult(state=CapacityState.UNKNOWN)
    total = int(amount)
    if total >= UNLIMITED_SPACE:
        return CapacityResult(state=CapacityState.ELASTIC)
    used = int(me.get("space_used") or 0)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=max(total - used, 0),
    )
