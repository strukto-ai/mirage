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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.core.jaeger._client import (JaegerApiError, fetch_traces,
                                        is_trace_id)
from mirage.resource.jaeger.config import JaegerConfig


class FakeResponse:

    def __init__(self, payload, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class RecordingAccessor(JaegerAccessor):

    def __init__(self, config: JaegerConfig, payload, status_code=200) -> None:
        super().__init__(config)
        self.calls: list[tuple[str, dict | None]] = []
        self._payload = payload
        self._status = status_code

    async def request(self, endpoint, params=None):
        self.calls.append((endpoint, params))
        return FakeResponse(self._payload, self._status)


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
async def test_fetch_traces_sends_explicit_microsecond_window():
    # Jaeger ignores `lookback`, so an explicit start/end must always be sent
    # or the search silently returns nothing.
    accessor = RecordingAccessor(JaegerConfig(), {"data": []})
    await fetch_traces(accessor, "checkout", limit=7)
    endpoint, params = accessor.calls[0]
    assert endpoint == "/api/traces"
    assert params["service"] == "checkout"
    assert params["limit"] == 7
    assert params["start"] == 0
    assert params["end"] > 0


@pytest.mark.asyncio
async def test_fetch_traces_converts_iso_window_to_micros():
    accessor = RecordingAccessor(JaegerConfig(), {"data": []})
    await fetch_traces(
        accessor,
        "checkout",
        from_timestamp="2026-01-01T00:00:00Z",
        to_timestamp="2026-01-02T00:00:00Z",
    )
    _endpoint, params = accessor.calls[0]
    assert params["start"] == 1767225600000000
    assert params["end"] == 1767312000000000


@pytest.mark.asyncio
async def test_fetch_traces_surfaces_api_error_message():
    accessor = RecordingAccessor(
        JaegerConfig(),
        {"errors": [{
            "code": 400,
            "msg": "parameter 'service' is required"
        }]},
        status_code=400,
    )
    with pytest.raises(JaegerApiError) as excinfo:
        await fetch_traces(accessor, "checkout")
    assert excinfo.value.status_code == 400
    assert "service" in str(excinfo.value)
