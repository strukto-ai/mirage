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

import socket

import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.tavily import TavilyAccessor
from mirage.core.tavily.client import (
    TavilyAPIError,
    TavilyKeylessLimit,
    TavilyUnanswered,
    tavily_request,
    timed_body,
)
from mirage.core.tavily.config import TavilyConfig

BASE = "https://api.tavily.com"
SEARCH = f"{BASE}/search"


@pytest.mark.asyncio
async def test_a_keyed_call_sends_the_key_and_mirage_as_its_source():
    async with TavilyAccessor(TavilyConfig(api_key="tvly-k")) as accessor:
        with aioresponses() as m:
            m.post(SEARCH, payload={"results": []})
            answer = await tavily_request(
                accessor, "POST", "search", {"query": "q"}, client_name="me"
            )
            sent = m.requests[("POST", URL(SEARCH))][0].kwargs
    assert answer == {"results": []}
    assert sent["json"] == {"query": "q"}
    assert sent["headers"]["Authorization"] == "Bearer tvly-k"
    assert sent["headers"]["X-Client-Source"] == "mirage"
    assert sent["headers"]["X-Client-Name"] == "me"
    assert "X-Tavily-Access-Mode" not in sent["headers"]


@pytest.mark.asyncio
async def test_a_keyless_call_says_so_instead_of_sending_a_key():
    async with TavilyAccessor(TavilyConfig()) as accessor:
        with aioresponses() as m:
            m.post(SEARCH, payload={})
            await tavily_request(accessor, "POST", "search", {"query": "q"})
            headers = m.requests[("POST", URL(SEARCH))][0].kwargs["headers"]
    assert "Authorization" not in headers
    assert headers["X-Tavily-Access-Mode"] == "keyless"
    assert headers["X-Client-Source"] == "mirage-keyless"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"detail": {"error": "Invalid API key"}}, "Invalid API key"),
        ({"error": {"message": "slow down"}}, "slow down"),
        ({"oops": 1}, '500 Error: {"oops":1}'),
    ],
)
async def test_a_refusal_carries_the_message_the_sdk_reads(body, message):
    async with TavilyAccessor(TavilyConfig(api_key="tvly-k")) as accessor:
        with aioresponses() as m:
            m.post(SEARCH, status=500, payload=body)
            with pytest.raises(TavilyAPIError) as raised:
                await tavily_request(accessor, "POST", "search", {})
    assert str(raised.value) == message
    assert raised.value.status == 500


@pytest.mark.asyncio
async def test_the_keyless_envelope_is_its_own_refusal():
    envelope = {
        "error": {
            "code": "keyless_cap",
            "message": "Daily cap reached",
            "next_actions": [{"type": "signup"}],
            "retry_after_seconds": 90,
        }
    }
    async with TavilyAccessor(TavilyConfig()) as accessor:
        with aioresponses() as m:
            m.post(SEARCH, status=429, payload=envelope)
            with pytest.raises(TavilyKeylessLimit) as raised:
                await tavily_request(accessor, "POST", "search", {})
    assert str(raised.value) == "Daily cap reached"
    assert raised.value.error["retry_after_seconds"] == 90


@pytest.mark.asyncio
async def test_a_call_that_never_connects_reads_as_the_sdk_words_it():
    async with TavilyAccessor(TavilyConfig(api_key="tvly-k")) as accessor:
        with aioresponses() as m:
            m.post(SEARCH, exception=aiohttp.ClientConnectionError("refused"))
            with pytest.raises(TavilyUnanswered) as raised:
                await tavily_request(accessor, "POST", "search", {})
    assert str(raised.value) == (
        "An unexpected error occurred while making the request. Error: refused"
    )


@pytest.mark.asyncio
async def test_a_refused_connection_prints_nodes_socket_error():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = TavilyConfig(
        api_key="tvly-k", base_url=f"http://127.0.0.1:{port}"
    )
    async with TavilyAccessor(config) as accessor:
        with pytest.raises(TavilyUnanswered) as raised:
            await tavily_request(accessor, "POST", "search", {})
    assert str(raised.value) == (
        "An unexpected error occurred while making the request. "
        f"Error: Error: connect ECONNREFUSED 127.0.0.1:{port}"
    )


def test_a_body_without_a_timeout_takes_the_verbs_default():
    body, seconds = timed_body({"urls": ["u"]}, 30.0)
    assert body == {"urls": ["u"], "timeout": 30}
    assert seconds == 30.0


def test_a_timeout_the_line_gave_is_kept_where_it_is():
    body, seconds = timed_body({"timeout": 5, "urls": ["u"]}, 30.0)
    assert body == {"timeout": 5, "urls": ["u"]}
    assert seconds == 5.0
