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

from mirage.core.gdrive.capacity import capacity
from mirage.types import CapacityResult, CapacityState

ABOUT = "/drive/v3/about"


@pytest.mark.asyncio
async def test_my_drives_quota_is_the_capacity(google_account):
    await google_account.upload("a.bin", b"x" * 400)
    quota = (await google_account.run.call("GET", ABOUT))["storageQuota"]
    accessor = google_account.drive_accessor(
        folder_id=await google_account.folder("scope")
    )
    total = int(quota["limit"])
    assert await capacity(accessor) == CapacityResult(
        state=CapacityState.QUOTA, total=total, used=400, available=total - 400
    )


@pytest.mark.asyncio
async def test_a_drive_with_no_limit_is_elastic(google_account):
    # An account with unlimited storage: Drive answers its usage and no
    # limit, which the fake's own quota is answered without.
    about = await google_account.run.call("GET", ABOUT)
    del about["storageQuota"]["limit"]
    await google_account.run.answer_next("GET", ABOUT, 200, about)
    accessor = google_account.drive_accessor(
        folder_id=await google_account.folder("scope")
    )
    assert await capacity(accessor) == CapacityResult(
        state=CapacityState.ELASTIC
    )


@pytest.mark.asyncio
async def test_a_shared_drive_has_no_quota_to_ask(google_account):
    drive = await google_account.shared_drive("Team")
    accessor = google_account.drive_accessor(
        folder_id=await google_account.folder("scope", drive)
    )
    await google_account.run.record_requests()
    assert await capacity(accessor) == CapacityResult(
        state=CapacityState.UNKNOWN
    )
    assert accessor.root_drive_id == drive
    assert all(
        route != f"GET {ABOUT}" for route, _ in await google_account.log()
    )
