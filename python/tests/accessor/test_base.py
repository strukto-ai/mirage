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

import aiohttp
import pytest

from mirage.accessor.base import Accessor, NOOPAccessor, SessionAccessor


@pytest.mark.asyncio
async def test_the_base_close_is_a_noop():
    await Accessor().close()
    await NOOPAccessor().close()


@pytest.mark.asyncio
async def test_a_session_accessor_pools_and_drains():
    acc = SessionAccessor()
    session = acc.pool.get()
    assert acc.pool.get() is session
    await acc.close()
    assert session.closed


@pytest.mark.asyncio
async def test_the_pool_is_inert_until_used():
    acc = SessionAccessor()
    assert acc.pool._session is None
    await acc.close()


@pytest.mark.asyncio
async def test_the_context_manager_drains_the_pool():
    async with SessionAccessor() as acc:
        session = acc.pool.get()
        assert not session.closed
    assert session.closed


@pytest.mark.asyncio
async def test_the_timeout_reaches_the_session():
    acc = SessionAccessor(timeout=aiohttp.ClientTimeout(total=7))
    assert acc.pool.get().timeout.total == 7
    await acc.close()
