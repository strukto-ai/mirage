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

import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.api.client import (NO_RETRY, RetryPolicy, SessionPool,
                                    _body_delay, api_request, header_delay,
                                    resolve_session, status_error)
from mirage.utils.ranges import ByteWindow

TARGET = "https://api.test/v1/thing"


class _Boom(RuntimeError):

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"boom {status}")
        self.status = status
        self.body = body


def _error_of(resp: aiohttp.ClientResponse, body: str) -> Exception:
    return _Boom(resp.status, body)


@pytest.mark.asyncio
async def test_json_read_returns_the_parsed_body():
    with aioresponses() as m:
        m.get(TARGET, payload={"ok": True})
        result = await api_request("GET", TARGET, error_of=_error_of)
    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_read_none_ignores_the_body():
    with aioresponses() as m:
        m.put(TARGET, status=204)
        result = await api_request("PUT",
                                   TARGET,
                                   error_of=_error_of,
                                   read="none")
    assert result is None


@pytest.mark.asyncio
async def test_an_error_status_maps_through_the_hook():
    with aioresponses() as m:
        m.get(TARGET, status=404, body='{"message": "nope"}')
        with pytest.raises(_Boom) as exc:
            await api_request("GET", TARGET, error_of=_error_of)
    assert exc.value.status == 404
    assert exc.value.body == '{"message": "nope"}'


@pytest.mark.asyncio
async def test_status_error_carries_the_response_status():
    with aioresponses() as m:
        m.get(TARGET, status=500, body="broken")
        with pytest.raises(aiohttp.ClientResponseError) as exc:
            await api_request("GET", TARGET, error_of=status_error)
    assert exc.value.status == 500


@pytest.mark.asyncio
async def test_body_delay_retries_then_succeeds():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=2,
                        delay_source="body")
    with aioresponses() as m:
        m.get(TARGET, status=429, payload={"retry_after": 0.001})
        m.get(TARGET, payload={"ok": 1})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 1}


@pytest.mark.asyncio
async def test_exhausted_retries_map_through_the_hook():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=2,
                        delay_source="body")
    with aioresponses() as m:
        for _ in range(3):
            m.get(TARGET, status=429, payload={"retry_after": 0.001})
        with pytest.raises(_Boom) as exc:
            await api_request("GET", TARGET, error_of=_error_of, retry=retry)
    assert exc.value.status == 429


@pytest.mark.asyncio
async def test_header_delay_retries_on_retry_after():
    retry = RetryPolicy(statuses=frozenset({503}), max_retries=1)
    with aioresponses() as m:
        m.get(TARGET, status=503, headers={"Retry-After": "0.001"})
        m.get(TARGET, payload={"ok": 2})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 2}


@pytest.mark.asyncio
async def test_no_retry_by_default():
    with aioresponses() as m:
        m.get(TARGET, status=429, payload={"retry_after": 30})
        with pytest.raises(_Boom):
            await api_request("GET",
                              TARGET,
                              error_of=_error_of,
                              retry=NO_RETRY)
    # a second registered response would have been consumed by a retry
    assert len(m.requests[("GET", URL(TARGET))]) == 1


@pytest.mark.asyncio
async def test_params_reach_the_query_string():
    with aioresponses() as m:
        m.get(f"{TARGET}?a=1&b=x", payload={"ok": 3})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   params={
                                       "a": 1,
                                       "b": "x"
                                   })
    assert result == {"ok": 3}


def test_header_delay_prefers_the_header_and_caps_every_wait():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)

    class _Resp:
        headers = {"Retry-After": "2.5"}

    assert header_delay(_Resp(), 0, retry) == 2.5

    class _Above:
        headers = {"Retry-After": "7.5"}

    # max_backoff is the ceiling on server-asked waits too, so a Retry-After
    # above it cannot stall a command past the configured limit
    assert header_delay(_Above(), 0, retry) == 4.0

    class _Bare:
        headers = {}

    assert header_delay(_Bare(), 1, retry) == 2.0
    assert header_delay(_Bare(), 6, retry) == 4.0

    class _Malformed:
        headers = {"Retry-After": "soon"}

    # malformed header falls back to exponential backoff
    assert header_delay(_Malformed(), 0, retry) == 1.0


def test_body_delay_reads_retry_after_and_falls_back():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)
    assert _body_delay('{"retry_after": 2.5}', retry) == 2.5
    assert _body_delay('{"retry_after": 7.5}', retry) == 4.0
    assert _body_delay('{"retry_after": "soon"}', retry) == 1.0
    assert _body_delay("not json", retry) == 1.0
    assert _body_delay("[1, 2]", retry) == 1.0
    # the 1s fallback bows to a ceiling below it
    tight = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=0.5)
    assert _body_delay("not json", tight) == 0.5


def test_header_delay_refuses_a_delay_it_could_never_wake_from():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)

    class _Resp:
        headers: dict[str, str] = {}

    # asyncio.sleep() never wakes from NaN or inf, and a negative delay
    # retries instantly: all fall back to backoff, as "soon" does.
    for value in ("NaN", "Infinity", "-Infinity", "-5"):
        _Resp.headers = {"Retry-After": value}
        assert header_delay(_Resp(), 0, retry) == 1.0


def test_body_delay_refuses_a_delay_it_could_never_wake_from():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)
    # json.loads accepts these literals, and 1e999 overflows to inf.
    assert _body_delay('{"retry_after": NaN}', retry) == 1.0
    assert _body_delay('{"retry_after": Infinity}', retry) == 1.0
    assert _body_delay('{"retry_after": 1e999}', retry) == 1.0
    assert _body_delay('{"retry_after": -5}', retry) == 1.0


@pytest.mark.asyncio
async def test_json_read_of_an_empty_body_is_none():
    with aioresponses() as m:
        m.get(TARGET, status=200, body="")
        result = await api_request("GET", TARGET, error_of=_error_of)
    assert result is None


@pytest.mark.asyncio
async def test_bytes_read_sends_the_range_and_trims_an_ignored_one():
    # a server may legally answer 200 with the whole body to a Range
    # request; the window trims it client-side
    with aioresponses() as m:
        m.get(TARGET, status=200, body=b"0123456789")
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   read="bytes",
                                   window=ByteWindow(2, 3))
        sent = m.requests[("GET", URL(TARGET))][0].kwargs
    assert result == b"234"
    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_bytes_read_trusts_a_206_window():
    with aioresponses() as m:
        m.get(TARGET, status=206, body=b"234")
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   read="bytes",
                                   window=ByteWindow(2, 3))
    assert result == b"234"


@pytest.mark.asyncio
async def test_text_read_returns_the_raw_body():
    with aioresponses() as m:
        m.get(TARGET, status=200, body="not json at all")
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   read="text")
    assert result == "not json at all"


@pytest.mark.asyncio
async def test_location_read_returns_the_header():
    with aioresponses() as m:
        m.post(TARGET,
               status=202,
               headers={"Location": "https://api.test/monitor/1"})
        result = await api_request("POST",
                                   TARGET,
                                   error_of=_error_of,
                                   json_body={},
                                   read="location")
    assert result == "https://api.test/monitor/1"


@pytest.mark.asyncio
async def test_data_sends_a_raw_body():
    with aioresponses() as m:
        m.put(TARGET, payload={"ok": 4})
        result = await api_request("PUT",
                                   TARGET,
                                   error_of=_error_of,
                                   data=b"\x00\x01")
        sent = m.requests[("PUT", URL(TARGET))][0].kwargs
    assert result == {"ok": 4}
    assert sent["data"] == b"\x00\x01"


@pytest.mark.asyncio
async def test_a_supplied_session_is_reused_and_left_open():
    async with aiohttp.ClientSession() as session:
        with aioresponses() as m:
            m.get(TARGET, payload={"n": 1})
            m.get(TARGET, payload={"n": 2})
            first = await api_request("GET",
                                      TARGET,
                                      error_of=_error_of,
                                      session=session)
            second = await api_request("GET",
                                       TARGET,
                                       error_of=_error_of,
                                       session=session)
        assert not session.closed
    assert first == {"n": 1}
    assert second == {"n": 2}


@pytest.mark.asyncio
async def test_transport_errors_retry_only_when_the_policy_says_so():
    retry = RetryPolicy(statuses=frozenset(),
                        max_retries=2,
                        max_backoff=0.001,
                        retry_transport=True)
    with aioresponses() as m:
        m.get(TARGET, exception=aiohttp.ClientConnectionError("refused"))
        m.get(TARGET, payload={"ok": 5})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 5}
    with aioresponses() as m:
        m.get(TARGET, exception=aiohttp.ClientConnectionError("refused"))
        with pytest.raises(aiohttp.ClientConnectionError):
            await api_request("GET", TARGET, error_of=_error_of)


@pytest.mark.asyncio
async def test_transport_retry_exhaustion_raises_the_transport_error():
    retry = RetryPolicy(statuses=frozenset(),
                        max_retries=1,
                        max_backoff=0.001,
                        retry_transport=True)
    with aioresponses() as m:
        m.get(TARGET, exception=aiohttp.ClientConnectionError("refused"))
        m.get(TARGET, exception=aiohttp.ClientConnectionError("refused"))
        with pytest.raises(aiohttp.ClientConnectionError):
            await api_request("GET", TARGET, error_of=_error_of, retry=retry)


@pytest.mark.asyncio
async def test_transport_retry_covers_timeouts():
    # a total timeout raises asyncio.TimeoutError, not ClientConnectionError
    retry = RetryPolicy(statuses=frozenset(),
                        max_retries=2,
                        max_backoff=0.001,
                        retry_transport=True)
    with aioresponses() as m:
        m.get(TARGET, exception=asyncio.TimeoutError())
        m.get(TARGET, payload={"ok": 6})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 6}
    with aioresponses() as m:
        m.get(TARGET, exception=asyncio.TimeoutError())
        with pytest.raises(asyncio.TimeoutError):
            await api_request("GET", TARGET, error_of=_error_of)


@pytest.mark.asyncio
async def test_a_pool_is_one_session_reused_and_recreated_after_close():
    pool = SessionPool()
    first = pool.get()
    assert pool.get() is first
    await pool.close()
    assert first.closed
    second = pool.get()
    assert second is not first
    await pool.close()


@pytest.mark.asyncio
async def test_the_pool_replaces_a_session_from_a_dead_loop():
    pool = SessionPool()
    first = pool.get()
    dead = asyncio.new_event_loop()
    dead.close()
    pool._loop = dead
    second = pool.get()
    assert second is not first
    assert pool.get() is second
    await first.close()
    await pool.close()


@pytest.mark.asyncio
async def test_resolve_session_materializes_a_pool_without_owning_it():
    pool = SessionPool()
    sess, own = resolve_session(pool)
    assert sess is pool.get()
    assert own is False
    await pool.close()


@pytest.mark.asyncio
async def test_resolve_session_borrows_a_live_session():
    async with aiohttp.ClientSession() as session:
        sess, own = resolve_session(session)
        assert sess is session
        assert own is False


@pytest.mark.asyncio
async def test_resolve_session_owns_one_when_absent():
    sess, own = resolve_session(None)
    assert own is True
    assert not sess.closed
    await sess.close()


@pytest.mark.asyncio
async def test_a_pool_rides_api_request_and_stays_open():
    pool = SessionPool()
    with aioresponses() as m:
        m.get(TARGET, payload={"n": 1})
        m.get(TARGET, payload={"n": 2})
        first = await api_request("GET",
                                  TARGET,
                                  error_of=_error_of,
                                  session=pool)
        second = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   session=pool)
    assert first == {"n": 1}
    assert second == {"n": 2}
    assert not pool.get().closed
    await pool.close()
