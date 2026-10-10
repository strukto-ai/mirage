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
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest

from mirage.core.slack.config import SlackConfig
from mirage.core.slack.search import MAX_PAGES, search_files, search_messages
from tests.core.slack.conftest import FakeSlack


@pytest.mark.asyncio
async def test_search_messages_defaults_include_page_1():
    cfg = SlackConfig(token="xoxp-test")
    with patch(
        "mirage.core.slack.search.slack_get",
        new=AsyncMock(return_value={"ok": True}),
    ) as fake_get:
        await search_messages(cfg, "hello")
    params = fake_get.call_args.kwargs["params"]
    assert params["query"] == "hello"
    assert params["count"] == 20
    assert params["page"] == 1
    assert params["sort"] == "timestamp"


@pytest.mark.asyncio
async def test_search_messages_forwards_explicit_count_and_page():
    cfg = SlackConfig(token="xoxp-test")
    with patch(
        "mirage.core.slack.search.slack_get",
        new=AsyncMock(return_value={"ok": True}),
    ) as fake_get:
        await search_messages(cfg, "hello", count=50, page=3)
    params = fake_get.call_args.kwargs["params"]
    assert params["count"] == 50
    assert params["page"] == 3


@pytest.mark.asyncio
async def test_search_files_calls_correct_endpoint():
    config = SlackConfig(token="xoxb", search_token="xoxp")
    with patch(
        "mirage.core.slack.search.slack_get",
        new_callable=AsyncMock,
        return_value={"ok": True, "files": {"matches": []}},
    ) as mock:
        await search_files(config, "report")
    args, kwargs = mock.call_args
    assert args[1] == "search.files"
    assert kwargs["params"]["query"] == "report"
    assert "token" not in kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, reads",
    [
        (
            "grep -rlw deploy /slack/channels",
            ["C1/2025-11-03", "C1/2025-11-06", "C2/2025-11-04"],
        ),
        ("grep -rlw rocket /slack/channels/general__C1", ["C1/2025-11-04"]),
        ("grep -rlw Launch /slack/channels/general__C1", ["C1/2025-11-05"]),
        (
            "grep -rlw Launch /slack/channels",
            ["C1/2025-11-05", "C2/2025-11-07"],
        ),
        (
            "grep -rlw deploy /slack",
            [
                "C1/2025-11-03",
                "C1/2025-11-06",
                "C2/2025-11-04",
                "D1/2025-11-03",
            ],
        ),
    ],
)
async def test_a_word_reads_only_the_days_search_names(slack, line, reads):
    # A file hit names every day a message shares it, not its upload.
    full = await slack(line, content_search=False)
    out, code, read, _ = await slack(line)
    assert (out, code) == full[:2]
    assert read == reads


@pytest.mark.asyncio
async def test_a_day_is_read_rather_than_searched(slack):
    line = "grep -rlw deploy /slack/channels/general__C1/2025-11-06"
    full = await slack(line, content_search=False)
    out, code, read, searches = await slack(line)
    assert (out, code, read) == full[:3]
    assert searches == []


@pytest.mark.asyncio
async def test_the_patterns_of_one_grep_share_one_user_listing(slack):
    fake = FakeSlack()
    await slack("grep -rlw -e deploy -e lunch /slack/channels", fake)
    assert fake.user_lists == 1


@pytest.mark.asyncio
async def test_a_channel_is_searched_by_name_and_reactions_too(slack):
    *_, searches = await slack("grep -rlw rocket /slack/channels/general__C1")
    assert searches == [
        "in:#general rocket",
        "in:#general ocket",
        "in:#general rocket",
        "in:#general ocket",
        "in:#general has::rocket:",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, fake",
    [
        ("grep -rlw text /slack/channels", FakeSlack()),
        ("grep -rlw Lima /slack/channels", FakeSlack()),
        ("grep -rlw nothing /slack/channels", FakeSlack()),
        ("grep -rlw deploy /slack/channels", FakeSlack(pages=MAX_PAGES + 1)),
        ("grep -rlw acme /slack/channels", FakeSlack()),
        ("grep -rlw Launch /slack/channels", FakeSlack(shares=False)),
        (
            "grep -rlw deploy /slack/channels",
            FakeSlack(fails=RuntimeError("Slack API error: ratelimited")),
        ),
        (
            "grep -rlw deploy /slack/channels",
            FakeSlack(fails=aiohttp.ClientConnectionError("reset")),
        ),
        (
            "grep -rlw deploy /slack/channels",
            FakeSlack(fails=asyncio.TimeoutError()),
        ),
        ("grep -rlw deploy /slack/dms", FakeSlack()),
    ],
)
async def test_every_day_is_read_when_search_cannot_answer(slack, line, fake):
    full = await slack(line, content_search=False)
    out, code, read, _ = await slack(line, fake)
    assert (out, code, read) == full[:3]
