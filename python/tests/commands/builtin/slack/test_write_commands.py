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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.commands.builtin.slack.slack_add_reaction import slack_react
from mirage.commands.builtin.slack.slack_post_message import slack_post_message
from mirage.commands.builtin.slack.slack_search import slack_search
from mirage.resource.slack.config import SlackConfig
from mirage.resource.slack.slack import SlackResource
from mirage.types import MountMode
from mirage.workspace.workspace import Workspace


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config)


@pytest.mark.asyncio
async def test_post_message(accessor, config):
    with patch(
            "mirage.commands.builtin.slack.slack_post_message"
            ".post_message",
            new_callable=AsyncMock,
            return_value={
                "ok": True,
                "ts": "123.456"
            },
    ) as mock_post:
        stream, io_result = await slack_post_message(accessor, [],
                                                     channel_id="C001",
                                                     text="hello world")

    mock_post.assert_called_once_with(config, "C001", "hello world")
    out = json.loads(stream)
    assert out["ok"] is True


@pytest.mark.asyncio
async def test_add_reaction(accessor, config):
    with patch(
            "mirage.commands.builtin.slack.slack_add_reaction"
            ".add_reaction",
            new_callable=AsyncMock,
            return_value={"ok": True},
    ) as mock_react:
        stream, io_result = await slack_react(accessor, [],
                                              channel_id="C001",
                                              ts="123.456",
                                              reaction="thumbsup")

    mock_react.assert_called_once_with(config, "C001", "123.456", "thumbsup")
    out = json.loads(stream)
    assert out["ok"] is True


@pytest.mark.asyncio
async def test_search(accessor, config):
    search_result = json.dumps({
        "ok": True,
        "messages": {
            "matches": [{
                "text": "found it"
            }]
        },
    }).encode()
    with patch(
            "mirage.commands.builtin.slack.slack_search"
            ".search_messages",
            new_callable=AsyncMock,
            return_value=search_result,
    ) as mock_search:
        stream, io_result = await slack_search(accessor, [],
                                               query="test query")

    mock_search.assert_called_once_with(config, "test query", count=20, page=1)
    out = json.loads(stream)
    assert out["ok"] is True


@pytest.mark.asyncio
async def test_search_forwards_count_and_page(accessor, config):
    with patch(
            "mirage.commands.builtin.slack.slack_search"
            ".search_messages",
            new_callable=AsyncMock,
            return_value=b'{"ok":true}',
    ) as mock_search:
        await slack_search(accessor, [], query="q", count="50", page="3")
    mock_search.assert_called_once_with(config, "q", count=50, page=3)


@pytest.mark.asyncio
async def test_search_rejects_count_above_100(accessor):
    with pytest.raises(ValueError, match="count"):
        await slack_search(accessor, [], query="q", count="101")


@pytest.mark.asyncio
async def test_search_rejects_page_below_1(accessor):
    with pytest.raises(ValueError, match="page"):
        await slack_search(accessor, [], query="q", page="0")


@pytest.mark.asyncio
async def test_search_rejects_non_integer_count(accessor):
    with pytest.raises(ValueError, match="count"):
        await slack_search(accessor, [], query="q", count="abc")


@pytest.mark.asyncio
async def test_post_message_through_dispatcher(config):
    """End-to-end: ensure command signature matches what the dispatcher
    actually passes (accessor, paths, *texts, **kw). A previous bug had
    these commands declaring (config, cache, paths, ...) which broke at
    runtime when invoked through Workspace.execute()."""
    resource = SlackResource(config)
    ws = Workspace({"/slack": resource}, mode=MountMode.WRITE)
    with patch(
            "mirage.commands.builtin.slack.slack_post_message"
            ".post_message",
            new_callable=AsyncMock,
            return_value={
                "ok": True,
                "ts": "9.99"
            },
    ) as mock_post:
        result = await ws.execute(
            'slack-post-message --channel_id C9 --text hi /slack/')
    assert result.exit_code == 0
    mock_post.assert_called_once_with(config, "C9", "hi")
