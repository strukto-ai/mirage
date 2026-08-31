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

import asyncio

import pytest

from mirage.core.api.oauth import TokenManager


class _FakeManager(TokenManager):

    def __init__(self, expires_in: float, buffer_seconds: float) -> None:
        super().__init__(buffer_seconds)
        self.expires_in = expires_in
        self.calls = 0

    async def refresh_pair(self) -> tuple[str, float]:
        self.calls += 1
        return f"tok{self.calls}", self.expires_in


@pytest.mark.asyncio
async def test_caches_until_expiry():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    assert await tm.get_token() == "tok1"
    assert await tm.get_token() == "tok1"
    assert tm.calls == 1


@pytest.mark.asyncio
async def test_the_buffer_refreshes_early():
    # 200s of lifetime minus a 300s buffer is already expired, so every
    # call refreshes.
    tm = _FakeManager(expires_in=200, buffer_seconds=300)
    assert await tm.get_token() == "tok1"
    assert await tm.get_token() == "tok2"
    assert tm.calls == 2


@pytest.mark.asyncio
async def test_concurrent_callers_share_one_refresh():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    tokens = await asyncio.gather(tm.get_token(), tm.get_token(),
                                  tm.get_token())
    assert tokens == ["tok1", "tok1", "tok1"]
    assert tm.calls == 1


@pytest.mark.asyncio
async def test_the_base_class_demands_a_refresh():
    with pytest.raises(NotImplementedError):
        await TokenManager().get_token()


@pytest.mark.asyncio
async def test_the_session_is_one_pool_reused():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    first = tm.session()
    assert tm.session() is first
    await tm.close()
    assert first.closed


@pytest.mark.asyncio
async def test_a_closed_manager_reopens_on_demand():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    first = tm.session()
    await tm.close()
    second = tm.session()
    assert second is not first
    assert not second.closed
    await tm.close()


@pytest.mark.asyncio
async def test_close_before_any_session_is_a_noop():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    await tm.close()
    await tm.close()


@pytest.mark.asyncio
async def test_the_context_manager_drains_the_pool():
    async with _FakeManager(expires_in=3600, buffer_seconds=300) as tm:
        session = tm.session()
        assert not session.closed
    assert session.closed


@pytest.mark.asyncio
async def test_the_pool_is_inert_until_a_session_is_asked_for():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    assert tm.pool._session is None
    await tm.close()
