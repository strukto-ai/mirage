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

from mirage.core.box.capacity import capacity
from mirage.core.box.constants import UNLIMITED_SPACE
from mirage.types import CapacityResult, CapacityState

ME_ROUTE = "/2.0/users/me"


@pytest.mark.asyncio
async def test_the_space_amount_is_the_quota(account):
    # The fake's account is a Personal one, with Box's amount and the
    # stored bytes as its use.
    me = await account.run.call("GET", ME_ROUTE)
    await account.put("a.txt", b"x" * 250)
    await account.run.record_requests()
    result = await capacity(account.accessor())
    assert await account.run.requests() == [f"GET {ME_ROUTE}"]
    total = me["space_amount"]
    assert result == CapacityResult(
        state=CapacityState.QUOTA, total=total, used=250, available=total - 250
    )


@pytest.mark.asyncio
async def test_an_unlimited_space_amount_is_elastic(account):
    await account.run.answer_next(
        "GET",
        ME_ROUTE,
        200,
        {"type": "user", "space_amount": UNLIMITED_SPACE, "space_used": 250},
    )
    assert await capacity(account.accessor()) == CapacityResult(
        state=CapacityState.ELASTIC
    )
