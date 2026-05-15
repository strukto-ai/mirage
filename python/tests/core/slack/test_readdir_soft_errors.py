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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.cache.index.config import IndexConfig
from mirage.core.slack.readdir import _fetch_day, _latest_message_ts, readdir
from mirage.resource.slack.config import SlackConfig
from mirage.types import IndexType, PathSpec


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test")


@pytest.fixture
def index():
    return RAMIndexCacheStore.from_config(
        IndexConfig(type=IndexType.RAM, ttl=600))


@pytest.mark.asyncio
async def test_latest_message_ts_returns_none_on_not_in_channel(config):
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel")
    with patch("mirage.core.slack.readdir.slack_get",
               new=AsyncMock(side_effect=err)):
        result = await _latest_message_ts(config, "C_INACCESSIBLE")
    assert result is None


@pytest.mark.asyncio
async def test_latest_message_ts_returns_none_on_missing_scope(config):
    err = RuntimeError(
        "Slack API error (conversations.history): missing_scope "
        "(needed: channels:history; provided: channels:read)")
    with patch("mirage.core.slack.readdir.slack_get",
               new=AsyncMock(side_effect=err)):
        result = await _latest_message_ts(config, "C_NO_SCOPE")
    assert result is None


@pytest.mark.asyncio
async def test_latest_message_ts_reraises_unrelated_errors(config):
    err = RuntimeError("Slack API error (conversations.history): rate_limited")
    with patch("mirage.core.slack.readdir.slack_get",
               new=AsyncMock(side_effect=err)):
        with pytest.raises(RuntimeError, match="rate_limited"):
            await _latest_message_ts(config, "C1")


@pytest.mark.asyncio
async def test_fetch_day_seals_empty_dir_on_not_in_channel(config, index):
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel")
    accessor = SlackAccessor(config=config)

    async def fake_history(_cfg, channel_id, date_str):
        raise err

    with patch("mirage.core.slack.readdir.fetch_messages_for_day",
               new=fake_history):
        await _fetch_day(accessor, "C_INACCESSIBLE", "2026-05-10",
                         "/slack/channels/foo__C_INACCESSIBLE/2026-05-10",
                         index)
    listing = await index.list_dir(
        "/slack/channels/foo__C_INACCESSIBLE/2026-05-10")
    assert listing.entries == []


@pytest.mark.asyncio
async def test_readdir_channel_inaccessible_yields_no_dates(config, index):
    """Full integration: ls /slack/channels/inaccessible/ → no dates."""
    accessor = SlackAccessor(config=config)
    channels_page = {
        "channels": [{
            "id": "C_INACCESSIBLE",
            "name": "private",
            "created": 1
        }],
        "response_metadata": {
            "next_cursor": ""
        },
    }
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel")

    async def fake_get(_cfg, method, params=None, token=None):
        if method == "conversations.list":
            return channels_page
        if method == "conversations.history":
            raise err
        raise AssertionError(f"unexpected {method}")

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get), \
         patch("mirage.core.slack.readdir.slack_get", new=fake_get):
        await readdir(
            accessor,
            PathSpec(original="/slack/channels",
                     directory="/slack/channels/",
                     prefix="/slack"),
            index,
        )
        dates = await readdir(
            accessor,
            PathSpec(
                original="/slack/channels/private__C_INACCESSIBLE",
                directory="/slack/channels/private__C_INACCESSIBLE/",
                prefix="/slack",
            ),
            index,
        )
    assert dates == []
