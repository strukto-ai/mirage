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

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.config import AirtableConfig
from mirage.utils.clock import ManualClock


@pytest.mark.asyncio
async def test_a_bound_clock_paces_every_base_call():
    accessor = AirtableAccessor(AirtableConfig(token="t"))
    clock = ManualClock()
    accessor.bind_clock(clock)
    rate = accessor.config.requests_per_second
    await accessor.limiter.acquire("appA")
    await accessor.limiter.acquire("appA")
    assert clock.monotonic() == pytest.approx(1 / rate)
