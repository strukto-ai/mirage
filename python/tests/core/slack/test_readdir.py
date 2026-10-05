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

from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.readdir import _date_range, readdir
from mirage.core.time_range import TimeRange
from mirage.types import PathSpec
from tests.fixtures.index_spy import WindowSpy


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
    result = await readdir(
        accessor,
        PathSpec(vfs_path="", virtual="/", directory="/"),
        index=index,
    )
    assert result == ["/channels", "/dms", "/users"]


@pytest.mark.asyncio
async def test_readdir_channels(accessor, index):
    channels = [
        {"id": "C001", "name": "general"},
        {"id": "C002", "name": "random"},
    ]
    with patch(
        "mirage.core.slack.readdir.list_channels",
        new_callable=AsyncMock,
        return_value=channels,
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="channels", virtual="/channels", directory="/channels"
            ),
            index=index,
        )

    assert "/channels/general__C001" in result
    assert "/channels/random__C002" in result


@pytest.mark.asyncio
async def test_readdir_users(accessor, index):
    users = [
        {"id": "U001", "name": "alice"},
        {"id": "U002", "name": "bob"},
    ]
    with patch(
        "mirage.core.slack.readdir.list_users",
        new_callable=AsyncMock,
        return_value=users,
    ):
        result = await readdir(
            accessor,
            PathSpec(vfs_path="users", virtual="/users", directory="/users"),
            index=index,
        )

    assert "/users/alice__U001.json" in result
    assert "/users/bob__U002.json" in result


@pytest.mark.asyncio
async def test_readdir_channel_dates(accessor, index):
    await index.set_dir(
        "/channels",
        [
            (
                "general__C001",
                IndexEntry(
                    id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                ),
            ),
        ],
    )

    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001",
                virtual="/channels/general__C001",
                directory="/channels/general__C001",
            ),
            index=index,
        )

    assert len(result) >= 1
    assert all(not r.endswith(".jsonl") for r in result)
    assert all(r.startswith("/channels/general__C001/") for r in result)
    assert result[0].endswith(now.strftime("%Y-%m-%d"))


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


def test_date_range_glob_span_escapes_the_cap():
    # A day dir is real for any date the channel has existed for, so a
    # glob older than the 90-day window must still list its days.
    now = datetime.now(timezone.utc)
    dates = _date_range(
        now.timestamp(), 1000000000, span=(date(2010, 3, 1), date(2010, 4, 1))
    )
    assert dates[0] == "2010-03-31"
    assert dates[-1] == "2010-03-01"
    assert len(dates) == 31


def test_date_range_glob_span_is_clipped_at_both_ends():
    # Nothing exists before the channel or after its newest message, so
    # the span is intersected rather than taken as typed.
    created = datetime(2010, 3, 10, tzinfo=timezone.utc).timestamp()
    latest = datetime(2010, 3, 20, tzinfo=timezone.utc).timestamp()
    dates = _date_range(
        latest, int(created), span=(date(2010, 3, 1), date(2010, 4, 1))
    )
    assert dates[0] == "2010-03-20"
    assert dates[-1] == "2010-03-10"


def test_date_range_glob_span_outside_the_channel_is_empty():
    created = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
    latest = datetime(2020, 1, 5, tzinfo=timezone.utc).timestamp()
    assert (
        _date_range(
            latest, int(created), span=(date(2010, 3, 1), date(2010, 4, 1))
        )
        == []
    )


@pytest.mark.asyncio
async def test_readdir_channels_stores_created(accessor, index):
    channels = [
        {"id": "C001", "name": "general", "created": 1700000000},
    ]
    with patch(
        "mirage.core.slack.readdir.list_channels",
        new_callable=AsyncMock,
        return_value=channels,
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="channels", virtual="/channels", directory="/channels"
            ),
            index=index,
        )
    lookup = await index.get("/channels/general__C001")
    assert lookup.entry is not None
    assert lookup.entry.remote_time == "1700000000"


@pytest.mark.asyncio
async def test_readdir_channel_dates_with_created(accessor, index):
    await index.set_dir(
        "/channels",
        [
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
        ],
    )
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001",
                virtual="/channels/general__C001",
                directory="/channels/general__C001",
            ),
            index=index,
        )
    assert len(result) == 90
    assert all(not r.endswith(".jsonl") for r in result)
    assert result[0].endswith(now.strftime("%Y-%m-%d"))


@pytest.mark.asyncio
async def test_readdir_channel_dates_cached_in_entries(accessor, index):
    await index.set_dir(
        "/channels",
        [
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
        ],
    )
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001",
                virtual="/channels/general__C001",
                directory="/channels/general__C001",
            ),
            index=index,
        )
    listing = await index.list_dir("/channels/general__C001")
    assert listing.entries is not None
    assert len(listing.entries) == 90
    assert all(not e.endswith(".jsonl") for e in listing.entries)


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_chat_and_files(accessor, index):
    await index.set_dir(
        "/channels",
        [
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
        ],
    )
    await index.set_dir(
        "/channels/general__C001",
        [
            (
                "2026-04-10",
                IndexEntry(
                    id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10",
                ),
            ),
        ],
    )

    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day",
        new_callable=AsyncMock,
        return_value=[],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001/2026-04-10",
                virtual="/channels/general__C001/2026-04-10",
                directory="/channels/general__C001/2026-04-10",
            ),
            index=index,
        )

    assert sorted(result) == [
        "/channels/general__C001/2026-04-10/chat.jsonl",
        "/channels/general__C001/2026-04-10/files",
    ]


@pytest.mark.asyncio
async def test_readdir_skips_unreadable_file_payloads(accessor, index):
    # Tombstoned and access-restricted file payloads carry an id but no
    # download URL and no size; they must not be listed, or sizes_always_known
    # would be false and read() would ENOENT on a listed file.
    await index.set_dir(
        "/channels",
        [
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
        ],
    )
    await index.set_dir(
        "/channels/general__C001",
        [
            (
                "2026-04-10",
                IndexEntry(
                    id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10",
                ),
            ),
        ],
    )
    messages = [
        {
            "ts": "1775000000.000100",
            "files": [
                {
                    "id": "F1",
                    "name": "report.pdf",
                    "size": 12,
                    "url_private_download": "https://files.slack.test/F1",
                },
                {
                    "id": "F2",
                    "mode": "tombstone",
                },
                {
                    "id": "F3",
                    "name": "restricted.docx",
                    "file_access": "check_file_info",
                },
            ],
        }
    ]
    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day",
        new_callable=AsyncMock,
        return_value=messages,
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001/2026-04-10",
                virtual="/channels/general__C001/2026-04-10",
                directory="/channels/general__C001/2026-04-10",
            ),
            index=index,
        )
    listing = await index.list_dir("/channels/general__C001/2026-04-10/files")
    assert listing.entries == [
        "/channels/general__C001/2026-04-10/files/report__F1.pdf"
    ]
    lookup = await index.get(
        "/channels/general__C001/2026-04-10/files/report__F1.pdf"
    )
    assert lookup.entry is not None
    assert lookup.entry.size == 12


async def _dm_without_created(index) -> SlackAccessor:
    await index.set_dir(
        "/dms",
        [
            (
                "alice__D001",
                IndexEntry(
                    id="D001",
                    name="alice",
                    resource_type="slack/dm",
                    vfs_name="alice__D001",
                ),
            ),
        ],
    )
    return SlackAccessor(
        SlackConfig(token="xoxb-test-token"),
        TimeRange.from_strings(None, "2026-06-02T00:00:00Z"),
    )


@pytest.mark.asyncio
async def test_end_scoped_glob_listing_skips_the_history_scan(index):
    accessor = await _dm_without_created(index)
    latest = datetime(2026, 6, 20, tzinfo=timezone.utc).timestamp()
    with (
        patch(
            "mirage.core.slack.readdir._latest_message_ts",
            new_callable=AsyncMock,
            return_value=latest,
        ),
        patch("mirage.core.slack.readdir.cursor_pages") as pages,
    ):
        result = await readdir(
            accessor,
            PathSpec(
                virtual="/dms/alice__D001/2026-05-*",
                directory="/dms/alice__D001/",
                vfs_path="dms/alice__D001/2026-05-*",
                pattern="2026-05-*",
            ),
            index=index,
        )
    pages.assert_not_called()
    assert len(result) == 31
    assert result[0] == "/dms/alice__D001/2026-05-31"
    assert result[-1] == "/dms/alice__D001/2026-05-01"


@pytest.mark.asyncio
async def test_end_scoped_bare_listing_pages_only_history_before_the_end(
    index,
):
    accessor = await _dm_without_created(index)
    latest = datetime(2026, 6, 20, tzinfo=timezone.utc).timestamp()
    first = datetime(2026, 5, 30, 12, tzinfo=timezone.utc).timestamp()
    end = datetime(2026, 6, 2, tzinfo=timezone.utc).timestamp()
    asked = []

    async def pages(config, endpoint, params, items_key, session=None):
        asked.append(params)
        yield [{"ts": f"{first + 3600:.6f}"}, {"ts": f"{first:.6f}"}]

    with (
        patch(
            "mirage.core.slack.readdir._latest_message_ts",
            new_callable=AsyncMock,
            return_value=latest,
        ),
        patch("mirage.core.slack.readdir.cursor_pages", new=pages),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="dms/alice__D001",
                virtual="/dms/alice__D001",
                directory="/dms/alice__D001",
            ),
            index=index,
        )
    assert asked == [{"channel": "D001", "limit": 200, "latest": f"{end:.6f}"}]
    assert result == [
        "/dms/alice__D001/2026-06-01",
        "/dms/alice__D001/2026-05-31",
        "/dms/alice__D001/2026-05-30",
    ]


@pytest.mark.asyncio
async def test_a_channel_listing_is_written_as_a_window(accessor):
    # The bare listing covers the last 90 days only; a day that falls out
    # of it still exists and is still readable by path.
    index = WindowSpy()
    await index.set_dir(
        "/channels",
        [
            (
                "general__C001",
                IndexEntry(
                    id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                ),
            ),
        ],
    )
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001",
                virtual="/channels/general__C001",
                directory="/channels/general__C001",
            ),
            index=index,
        )
    assert index.windows["/channels/general__C001"] is True


FILES_DIR = "/channels/general__C001/2026-04-10/files"
REPORT = {
    "id": "F1ABC",
    "name": "report.pdf",
    "title": "report.pdf",
    "filetype": "pdf",
    "mimetype": "application/pdf",
    "size": 4096,
    "url_private_download": (
        "https://files.slack.com/files-pri/T1-F1ABC/download/report.pdf"
    ),
    "timestamp": 1712707200,
}


async def _list_files_dir(accessor, index, messages) -> list[str]:
    await index.set_dir(
        "/channels",
        [
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
        ],
    )
    await index.set_dir(
        "/channels/general__C001",
        [
            (
                "2026-04-10",
                IndexEntry(
                    id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10",
                ),
            ),
        ],
    )
    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day",
        new_callable=AsyncMock,
        return_value=messages,
    ):
        return await readdir(
            accessor,
            PathSpec(
                vfs_path=FILES_DIR.lstrip("/"),
                virtual=FILES_DIR,
                directory=FILES_DIR,
            ),
            index=index,
        )


@pytest.mark.asyncio
async def test_files_dir_lists_attachments_and_indexes_their_url(
    accessor, index
):
    messages = [
        {
            "type": "message",
            "user": "U1",
            "ts": "1712707200.0",
            "files": [REPORT],
        },
        {
            "type": "message",
            "user": "U2",
            "ts": "1712707260.0",
            "text": "no file here",
        },
    ]
    result = await _list_files_dir(accessor, index, messages)
    assert result == [f"{FILES_DIR}/report__F1ABC.pdf"]
    blob = await index.get(f"{FILES_DIR}/report__F1ABC.pdf")
    assert blob.entry is not None
    assert blob.entry.id == "F1ABC"
    assert blob.entry.size == 4096
    assert blob.entry.extra["mimetype"] == "application/pdf"
    assert "url_private_download" in blob.entry.extra
    assert blob.entry.extra["filetype"] == "pdf"
    assert blob.entry.extra["ts"] == "1712707200.0"


@pytest.mark.asyncio
async def test_files_dir_empty_on_no_attachments(accessor, index):
    messages = [
        {"type": "message", "user": "U1", "ts": "1712707200.0", "text": "hi"}
    ]
    assert await _list_files_dir(accessor, index, messages) == []
