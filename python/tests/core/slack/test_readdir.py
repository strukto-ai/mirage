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

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.readdir import _date_range, readdir
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(accessor,
                           PathSpec(original="/", directory="/"),
                           index=index)
    assert result == ["/channels", "/dms", "/users"]


@pytest.mark.asyncio
async def test_readdir_channels(accessor, index):
    channels = [
        {
            "id": "C001",
            "name": "general"
        },
        {
            "id": "C002",
            "name": "random"
        },
    ]
    with patch(
            "mirage.core.slack.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=channels,
    ):
        result = await readdir(accessor,
                               PathSpec(original="/channels",
                                        directory="/channels"),
                               index=index)

    assert "/channels/general__C001" in result
    assert "/channels/random__C002" in result


@pytest.mark.asyncio
async def test_readdir_users(accessor, index):
    users = [
        {
            "id": "U001",
            "name": "alice"
        },
        {
            "id": "U002",
            "name": "bob"
        },
    ]
    with patch(
            "mirage.core.slack.readdir.list_users",
            new_callable=AsyncMock,
            return_value=users,
    ):
        result = await readdir(accessor,
                               PathSpec(original="/users", directory="/users"),
                               index=index)

    assert "/users/alice__U001.json" in result
    assert "/users/bob__U002.json" in result


@pytest.mark.asyncio
async def test_readdir_channel_dates(accessor, index):
    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                vfs_name="general__C001",
            ),
        ),
    ])

    now = datetime.now(timezone.utc)
    with patch("mirage.core.slack.readdir._latest_message_ts",
               new_callable=AsyncMock,
               return_value=now.timestamp()):
        result = await readdir(accessor,
                               PathSpec(original="/channels/general__C001",
                                        directory="/channels/general__C001"),
                               index=index)

    assert len(result) >= 1
    assert all(not r.endswith(".jsonl") for r in result)
    assert all(r.startswith("/channels/general__C001/") for r in result)
    assert result[0].endswith(now.strftime('%Y-%m-%d'))


def test_date_range_recent():
    now = datetime.now(timezone.utc)
    latest = now.timestamp()
    created = int(now.timestamp()) - 86400 * 5
    dates = _date_range(latest, created)
    assert len(dates) == 6
    assert dates[0] == now.strftime("%Y-%m-%d")


def test_date_range_capped_at_90():
    now = datetime.now(timezone.utc)
    dates = _date_range(now.timestamp(), 1000000000)
    assert len(dates) == 90


@pytest.mark.asyncio
async def test_readdir_channels_stores_created(accessor, index):
    channels = [
        {
            "id": "C001",
            "name": "general",
            "created": 1700000000
        },
    ]
    with patch(
            "mirage.core.slack.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=channels,
    ):
        await readdir(accessor,
                      PathSpec(original="/channels", directory="/channels"),
                      index=index)
    lookup = await index.get("/channels/general__C001")
    assert lookup.entry is not None
    assert lookup.entry.remote_time == "1700000000"


@pytest.mark.asyncio
async def test_readdir_channel_dates_with_created(accessor, index):

    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                remote_time="1700000000",
                vfs_name="general__C001",
            ),
        ),
    ])
    now = datetime.now(timezone.utc)
    with patch("mirage.core.slack.readdir._latest_message_ts",
               new_callable=AsyncMock,
               return_value=now.timestamp()):
        result = await readdir(accessor,
                               PathSpec(original="/channels/general__C001",
                                        directory="/channels/general__C001"),
                               index=index)
    assert len(result) == 90
    assert all(not r.endswith(".jsonl") for r in result)
    assert result[0].endswith(now.strftime('%Y-%m-%d'))


@pytest.mark.asyncio
async def test_readdir_channel_dates_cached_in_entries(accessor, index):

    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                remote_time="1700000000",
                vfs_name="general__C001",
            ),
        ),
    ])
    now = datetime.now(timezone.utc)
    with patch("mirage.core.slack.readdir._latest_message_ts",
               new_callable=AsyncMock,
               return_value=now.timestamp()):
        await readdir(accessor,
                      PathSpec(original="/channels/general__C001",
                               directory="/channels/general__C001"),
                      index=index)
    listing = await index.list_dir("/channels/general__C001")
    assert listing.entries is not None
    assert len(listing.entries) == 90
    assert all(not e.endswith(".jsonl") for e in listing.entries)


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_chat_and_files(accessor, index):
    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                vfs_name="general__C001",
                remote_time="1700000000",
            ),
        ),
    ])
    await index.set_dir("/channels/general__C001", [
        (
            "2026-04-10",
            IndexEntry(
                id="C001:2026-04-10",
                name="2026-04-10",
                resource_type="slack/date_dir",
                vfs_name="2026-04-10",
            ),
        ),
    ])

    with patch("mirage.core.slack.readdir.fetch_messages_for_day",
               new_callable=AsyncMock,
               return_value=[]):
        result = await readdir(
            accessor,
            PathSpec(original="/channels/general__C001/2026-04-10",
                     directory="/channels/general__C001/2026-04-10"),
            index=index,
        )

    assert sorted(result) == [
        "/channels/general__C001/2026-04-10/chat.jsonl",
        "/channels/general__C001/2026-04-10/files",
    ]
