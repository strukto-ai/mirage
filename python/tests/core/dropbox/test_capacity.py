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

from mirage.core.dropbox.capacity import capacity
from mirage.types import CapacityResult, CapacityState

USAGE_ROUTE = "/2/users/get_space_usage"


def _quota(total: int, used: int) -> CapacityResult:
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=total - used,
    )


@pytest.mark.asyncio
async def test_an_individual_allocation_is_the_quota(account):
    # The fake's account is a Basic one, with the stored bytes as its use.
    usage = await account.run.call("POST", USAGE_ROUTE)
    await account.put("/a.txt", b"x" * 300)
    await account.run.record_requests()
    result = await capacity(account.accessor())
    assert await account.run.bodies("POST", USAGE_ROUTE) == [None]
    assert result == _quota(usage["allocation"]["allocated"], 300)


@pytest.mark.parametrize(
    ("allocation", "used", "total"),
    [
        (
            {
                ".tag": "team",
                "used": 900,
                "allocated": 5000,
                "user_within_team_space_allocated": 1000,
            },
            300,
            1000,
        ),
        (
            {
                ".tag": "team",
                "used": 900,
                "allocated": 5000,
                "user_within_team_space_allocated": 0,
            },
            900,
            5000,
        ),
    ],
    ids=["member-cap", "team-pool"],
)
@pytest.mark.asyncio
async def test_the_allocation_that_bounds_a_team_account_is_the_quota(
    account, allocation, used, total
):
    await account.run.answer_next(
        "POST", USAGE_ROUTE, 200, {"used": 300, "allocation": allocation}
    )
    assert await capacity(account.accessor()) == _quota(total, used)
