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
import pytest_asyncio
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import download_file, slack_get, slack_post
from mirage.core.slack.config import SlackConfig

BASE = "https://slack.com/api"


@pytest_asyncio.fixture
async def accessor():
    async with SlackAccessor(SlackConfig(token="xoxb-test-token")) as acc:
        yield acc


@pytest.mark.asyncio
async def test_slack_get_success(accessor):
    url = f"{BASE}/conversations.list?limit=10"
    with aioresponses() as m:
        m.get(url, payload={"ok": True, "channels": []})
        result = await slack_get(
            accessor, "conversations.list", params={"limit": 10}
        )
        sent = m.requests[("GET", URL(url))]
    assert result["ok"] is True
    assert len(sent) == 1
    assert (
        sent[0].kwargs["headers"]["Authorization"] == "Bearer xoxb-test-token"
    )


@pytest.mark.asyncio
async def test_slack_get_uses_search_token_for_search_methods():
    config = SlackConfig(token="xoxb-bot", search_token="xoxp-user")
    url = f"{BASE}/search.messages?query=hello"
    with aioresponses() as m:
        m.get(url, payload={"ok": True, "messages": {"matches": []}})
        async with SlackAccessor(config) as accessor:
            result = await slack_get(
                accessor, "search.messages", params={"query": "hello"}
            )
        sent = m.requests[("GET", URL(url))]
    assert result["ok"] is True
    assert sent[0].kwargs["headers"]["Authorization"] == "Bearer xoxp-user"


@pytest.mark.asyncio
async def test_slack_get_error(accessor):
    # Slack reports failures in-band: HTTP 200 with ok:false.
    url = f"{BASE}/conversations.info"
    with aioresponses() as m:
        m.get(url, payload={"ok": False, "error": "channel_not_found"})
        with pytest.raises(
            RuntimeError, match=r"\(conversations\.info\): channel_not_found"
        ):
            await slack_get(accessor, "conversations.info")


@pytest.mark.asyncio
async def test_slack_get_http_error_keeps_slack_wording(accessor):
    # A non-2xx that still carries Slack's envelope keeps Slack's own
    # error string rather than a bare status line.
    url = f"{BASE}/conversations.info"
    with aioresponses() as m:
        m.get(
            url,
            status=429,
            payload={
                "ok": False,
                "error": "ratelimited",
            },
        )
        with pytest.raises(
            RuntimeError, match=r"\(conversations\.info\): ratelimited"
        ):
            await slack_get(accessor, "conversations.info")


@pytest.mark.asyncio
async def test_slack_get_http_error_without_envelope_reports_status(accessor):
    url = f"{BASE}/conversations.info"
    with aioresponses() as m:
        m.get(url, status=502, body="<html>gateway</html>")
        with pytest.raises(
            RuntimeError, match=r"\(conversations\.info\): HTTP 502"
        ):
            await slack_get(accessor, "conversations.info")


@pytest.mark.asyncio
async def test_slack_get_missing_scope_surfaces_scopes(accessor):
    url = f"{BASE}/conversations.list"
    with aioresponses() as m:
        m.get(
            url,
            payload={
                "ok": False,
                "error": "missing_scope",
                "needed": "im:read,mpim:read",
                "provided": "channels:read,users:read",
            },
        )
        with pytest.raises(
            RuntimeError,
            match=(
                r"\(conversations\.list\): missing_scope "
                r"\(needed: im:read,mpim:read; "
                r"provided: channels:read,users:read\)"
            ),
        ):
            await slack_get(accessor, "conversations.list")


@pytest.mark.asyncio
async def test_slack_get_missing_scope_no_needed_falls_back(accessor):
    url = f"{BASE}/conversations.list"
    with aioresponses() as m:
        m.get(url, payload={"ok": False, "error": "missing_scope"})
        with pytest.raises(RuntimeError) as ei:
            await slack_get(accessor, "conversations.list")
        assert str(ei.value).endswith(
            "Slack API error (conversations.list): missing_scope"
        )


@pytest.mark.asyncio
async def test_slack_post_success(accessor):
    url = f"{BASE}/chat.postMessage"
    with aioresponses() as m:
        m.post(url, payload={"ok": True, "ts": "1234567890.123456"})
        result = await slack_post(
            accessor,
            "chat.postMessage",
            body={
                "channel": "C123",
                "text": "hello",
            },
        )
        sent = m.requests[("POST", URL(url))]
    assert result["ok"] is True
    assert result["ts"] == "1234567890.123456"
    assert len(sent) == 1
    assert sent[0].kwargs["json"] == {"channel": "C123", "text": "hello"}


@pytest.mark.asyncio
async def test_download_file_uses_bot_token():
    both = SlackAccessor(SlackConfig(token="xoxb-bot", search_token="xoxp-u"))
    bot = SlackAccessor(SlackConfig(token="xoxb-bot"))
    with aioresponses() as m:
        m.get("http://x", body=b"OK")
        m.get("http://x", body=b"OK")
        async with both, bot:
            await download_file(both, "http://x")
            await download_file(bot, "http://x")
        sent = m.requests[("GET", URL("http://x"))]
    assert sent[0].kwargs["headers"] == {"Authorization": "Bearer xoxb-bot"}
    assert sent[1].kwargs["headers"] == {"Authorization": "Bearer xoxb-bot"}
