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

from mirage.core.discord.search import search_guild
from mirage.resource.discord.config import DiscordConfig


def _run(coro):
    return asyncio.run(coro)


def _config():
    return DiscordConfig(token="test-token")


def _make_search_response(messages, total=None):
    hits = [[msg] for msg in messages]
    return {"messages": hits, "total_results": total or len(messages)}


def test_search_returns_messages():
    msgs = [
        {
            "id": "100",
            "content": "hello world",
            "author": {
                "username": "a"
            }
        },
        {
            "id": "200",
            "content": "hello again",
            "author": {
                "username": "b"
            }
        },
    ]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=_make_search_response(msgs)):
        results = _run(search_guild(_config(), "G1", "hello"))
    assert len(results) == 2
    assert results[0]["id"] == "100"
    assert results[1]["id"] == "200"


def test_search_with_channel_filter():
    msgs = [{"id": "300", "content": "test", "author": {"username": "c"}}]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=_make_search_response(msgs)) as mock:
        results = _run(search_guild(_config(), "G1", "test", channel_id="C1"))
    assert len(results) == 1
    call_params = mock.call_args[1].get("params") or mock.call_args[0][2]
    assert call_params["channel_id"] == "C1"
    assert call_params["content"] == "test"


def test_search_empty_results():
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value={
                   "messages": [],
                   "total_results": 0
               }):
        results = _run(search_guild(_config(), "G1", "nonexistent"))
    assert results == []


def test_search_sorted_oldest_first():
    msgs = [
        {
            "id": "500",
            "content": "newer",
            "author": {
                "username": "a"
            }
        },
        {
            "id": "100",
            "content": "older",
            "author": {
                "username": "b"
            }
        },
    ]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=_make_search_response(msgs)):
        results = _run(search_guild(_config(), "G1", "hello"))
    assert results[0]["id"] == "100"
    assert results[1]["id"] == "500"


def test_search_respects_limit():
    msgs = [{
        "id": str(i),
        "content": f"msg{i}",
        "author": {
            "username": "a"
        }
    } for i in range(10)]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=_make_search_response(msgs, total=10)):
        results = _run(search_guild(_config(), "G1", "msg", limit=3))
    assert len(results) == 3


def test_search_paginates():
    page1 = [{
        "id": str(i),
        "content": f"msg{i}",
        "author": {
            "username": "a"
        }
    } for i in range(25)]
    page2 = [{
        "id": str(i + 25),
        "content": f"msg{i + 25}",
        "author": {
            "username": "a"
        }
    } for i in range(5)]
    responses = [
        _make_search_response(page1, total=30),
        _make_search_response(page2, total=30),
    ]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=responses):
        results = _run(search_guild(_config(), "G1", "msg", limit=100))
    assert len(results) == 30
