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

import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.capacity import capacity
from mirage.types import CapacityResult, CapacityState


@pytest.mark.asyncio
async def test_the_quota_facet_is_the_capacity():
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive?$select=quota",
            payload={"quota": {"total": 1000, "used": 300, "remaining": 650}},
        )
        result = await capacity(
            OneDriveAccessor(OneDriveConfig(access_token="tok"))
        )
    assert result == CapacityResult(
        state=CapacityState.QUOTA, total=1000, used=300, available=650
    )
