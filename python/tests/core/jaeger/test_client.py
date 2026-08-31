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

import re

import aiohttp
import pytest
from aioresponses import aioresponses

from mirage.accessor.jaeger import JaegerAccessor
from mirage.core.jaeger.client import JaegerApiError, fetch_traces, is_trace_id
from mirage.resource.jaeger.config import JaegerConfig

TRACES_URL = re.compile(r"^http://localhost:16686/api/traces\?.*$")


def sent_params(m: aioresponses) -> dict:
    ((_key, calls), ) = m.requests.items()
    assert len(calls) == 1
    return calls[0].kwargs["params"]


@pytest.mark.parametrize("value,valid", [
    ("a" * 32, True),
    ("a" * 16, True),
    ("A" * 32, True),
    ("zzz", False),
    ("a" * 31, False),
    ("a" * 33, False),
    ("", False),
])
def test_is_trace_id(value, valid):
    assert is_trace_id(value) is valid


@pytest.mark.asyncio
async def test_accessor_reuses_session_and_closes_it():
    accessor = JaegerAccessor(JaegerConfig(request_timeout=12))
    first = accessor.pool.get()
    second = accessor.pool.get()

    assert first is second
    assert first.timeout == aiohttp.ClientTimeout(total=12)

    await accessor.close()

    assert first.closed is True
    assert accessor.pool._session is None


@pytest.mark.asyncio
async def test_fetch_traces_sends_explicit_microsecond_window():
    # Jaeger ignores `lookback`, so an explicit start/end must always be sent
    # or the search silently returns nothing.
    accessor = JaegerAccessor(JaegerConfig())
    with aioresponses() as m:
        m.get(TRACES_URL, payload={"data": []})
        try:
            await fetch_traces(accessor, "checkout", limit=7)
        finally:
            await accessor.close()
        params = sent_params(m)
    assert params["service"] == "checkout"
    assert params["limit"] == 7
    assert params["start"] == 0
    assert params["end"] > 0


@pytest.mark.asyncio
async def test_fetch_traces_converts_iso_window_to_micros():
    accessor = JaegerAccessor(JaegerConfig())
    with aioresponses() as m:
        m.get(TRACES_URL, payload={"data": []})
        try:
            await fetch_traces(
                accessor,
                "checkout",
                from_timestamp="2026-01-01T00:00:00Z",
                to_timestamp="2026-01-02T00:00:00Z",
            )
        finally:
            await accessor.close()
        params = sent_params(m)
    assert params["start"] == 1767225600000000
    assert params["end"] == 1767312000000000


@pytest.mark.asyncio
async def test_fetch_traces_surfaces_api_error_message():
    accessor = JaegerAccessor(JaegerConfig())
    with aioresponses() as m:
        m.get(TRACES_URL,
              status=400,
              payload={
                  "errors": [{
                      "code": 400,
                      "msg": "parameter 'service' is required"
                  }]
              })
        try:
            with pytest.raises(JaegerApiError) as excinfo:
                await fetch_traces(accessor, "checkout")
        finally:
            await accessor.close()
    assert excinfo.value.status_code == 400
    assert "service" in str(excinfo.value)


@pytest.mark.asyncio
async def test_fetch_traces_reports_status_without_body_message():
    accessor = JaegerAccessor(JaegerConfig())
    with aioresponses() as m:
        m.get(TRACES_URL, status=503, body="upstream unavailable")
        try:
            with pytest.raises(JaegerApiError) as excinfo:
                await fetch_traces(accessor, "checkout")
        finally:
            await accessor.close()
    assert excinfo.value.status_code == 503
    assert str(excinfo.value) == "Jaeger API error: HTTP 503"


@pytest.mark.asyncio
async def test_fetch_traces_rejects_non_object_payload():
    accessor = JaegerAccessor(JaegerConfig())
    with aioresponses() as m:
        m.get(TRACES_URL, payload=["not", "an", "object"])
        try:
            with pytest.raises(JaegerApiError) as excinfo:
                await fetch_traces(accessor, "checkout")
        finally:
            await accessor.close()
    assert "JSON object" in str(excinfo.value)
