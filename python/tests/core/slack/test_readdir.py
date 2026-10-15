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
from mirage.core.hierarchy.probe import rows_of
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.readdir import _date_range, readdir
from mirage.core.time_range import TimeRange
from mirage.types import DirListing, FileStat, FileType, PathSpec


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


def _channel(
    dirname: str = "general__C001", created: int = 0, name: str = "general"
) -> FileStat:
    """A conversation's row as its container's listing names it."""
    return FileStat(
        name=dirname,
        type=FileType.DIRECTORY,
        extra={
            "channel_id": dirname.rsplit("__", 1)[1],
            "name": name,
            "created": created,
        },
    )


DAY = FileStat(
    name="2026-04-10", type=FileType.DIRECTORY, extra={"channel_id": "C001"}
)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


def _paths(listed: list[FileStat] | DirListing, folder: str) -> list[str]:
    return [f"{folder.rstrip('/')}/{row.name}" for row in rows_of(listed)]


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(accessor, _spec("/"))
    assert _paths(result, "/") == ["/channels", "/dms", "/users"]


@pytest.mark.asyncio
async def test_readdir_channels(accessor):
    channels = [
        {"id": "C001", "name": "general"},
        {"id": "C002", "name": "random"},
    ]
    with patch(
        "mirage.core.slack.readdir.list_channels",
        new_callable=AsyncMock,
        return_value=channels,
    ):
        result = _paths(
            await readdir(accessor, _spec("/channels")), "/channels"
        )

    assert "/channels/general__C001" in result
    assert "/channels/random__C002" in result


@pytest.mark.asyncio
async def test_readdir_users(accessor):
    users = [
        {"id": "U001", "name": "alice"},
        {"id": "U002", "name": "bob"},
    ]
    with patch(
        "mirage.core.slack.readdir.list_users",
        new_callable=AsyncMock,
        return_value=users,
    ):
        result = _paths(await readdir(accessor, _spec("/users")), "/users")

    assert "/users/alice__U001.json" in result
    assert "/users/bob__U002.json" in result


@pytest.mark.asyncio
async def test_readdir_channel_dates(accessor):
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        listed = await readdir(
            accessor, _spec("/channels/general__C001"), _channel()
        )
    result = _paths(listed, "/channels/general__C001")
    assert len(result) >= 1
    assert all(not r.endswith(".jsonl") for r in result)
    assert result[0].endswith(now.strftime("%Y-%m-%d"))
    assert listed.entries[0].extra == {"channel_id": "C001"}


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
async def test_readdir_channels_keeps_created(accessor):
    channels = [
        {"id": "C001", "name": "general", "created": 1700000000},
    ]
    with patch(
        "mirage.core.slack.readdir.list_channels",
        new_callable=AsyncMock,
        return_value=channels,
    ):
        (row,) = await readdir(accessor, _spec("/channels"))
    assert row.extra["created"] == 1700000000
    assert row.modified is not None


@pytest.mark.asyncio
async def test_readdir_channel_dates_with_created(accessor):
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        listed = await readdir(
            accessor,
            _spec("/channels/general__C001"),
            _channel(created=1700000000),
        )
    result = _paths(listed, "/channels/general__C001")
    assert len(result) == 90
    assert all(not r.endswith(".jsonl") for r in result)
    assert result[0].endswith(now.strftime("%Y-%m-%d"))


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_chat_and_files(accessor):
    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day",
        new_callable=AsyncMock,
        return_value=[],
    ):
        listed = await readdir(
            accessor,
            _spec("/channels/general__C001/2026-04-10"),
            DAY,
        )

    assert sorted(_paths(listed, "/channels/general__C001/2026-04-10")) == [
        "/channels/general__C001/2026-04-10/chat.jsonl",
        "/channels/general__C001/2026-04-10/files",
    ]


@pytest.mark.asyncio
async def test_readdir_skips_unreadable_file_payloads(accessor):
    # Tombstoned and access-restricted file payloads carry an id but no
    # download URL and no size; they must not be listed, or sizes_always_known
    # would be false and read() would ENOENT on a listed file.
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
        listed = await readdir(
            accessor,
            _spec("/channels/general__C001/2026-04-10"),
            DAY,
        )
    (blob,) = listed.seeds["files"]
    assert blob.name == "report__F1.pdf"
    assert blob.size == 12


def _dm_without_created() -> SlackAccessor:
    return SlackAccessor(
        SlackConfig(token="xoxb-test-token"),
        TimeRange.from_strings(None, "2026-06-02T00:00:00Z"),
    )


DM = _channel("alice__D001", name="alice")


@pytest.mark.asyncio
async def test_end_scoped_glob_listing_skips_the_history_scan():
    accessor = _dm_without_created()
    latest = datetime(2026, 6, 20, tzinfo=timezone.utc).timestamp()
    with (
        patch(
            "mirage.core.slack.readdir._latest_message_ts",
            new_callable=AsyncMock,
            return_value=latest,
        ),
        patch("mirage.core.slack.readdir.cursor_pages") as pages,
    ):
        listed = await readdir(
            accessor,
            PathSpec(
                virtual="/dms/alice__D001/2026-05-*",
                directory="/dms/alice__D001/",
                vfs_path="dms/alice__D001/2026-05-*",
                pattern="2026-05-*",
            ),
            DM,
        )
    pages.assert_not_called()
    result = _paths(listed, "/dms/alice__D001")
    assert len(result) == 31
    assert result[0] == "/dms/alice__D001/2026-05-31"
    assert result[-1] == "/dms/alice__D001/2026-05-01"


@pytest.mark.asyncio
async def test_end_scoped_bare_listing_pages_only_history_before_the_end():
    accessor = _dm_without_created()
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
        listed = await readdir(accessor, _spec("/dms/alice__D001"), DM)
    assert asked == [{"channel": "D001", "limit": 200, "latest": f"{end:.6f}"}]
    assert _paths(listed, "/dms/alice__D001") == [
        "/dms/alice__D001/2026-06-01",
        "/dms/alice__D001/2026-05-31",
        "/dms/alice__D001/2026-05-30",
    ]


@pytest.mark.asyncio
async def test_a_channel_listing_is_a_window(accessor):
    # The bare listing covers the last 90 days only; a day that falls out
    # of it still exists and is still readable by path.
    now = datetime.now(timezone.utc)
    with patch(
        "mirage.core.slack.readdir._latest_message_ts",
        new_callable=AsyncMock,
        return_value=now.timestamp(),
    ):
        listed = await readdir(
            accessor, _spec("/channels/general__C001"), _channel()
        )
    assert listed.window is True


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


async def _list_files_dir(accessor, messages) -> list[FileStat]:
    files = FileStat(
        name="files",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C001", "date": "2026-04-10"},
    )
    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day",
        new_callable=AsyncMock,
        return_value=messages,
    ):
        return rows_of(await readdir(accessor, _spec(FILES_DIR), files))


@pytest.mark.asyncio
async def test_files_dir_lists_attachments_and_keeps_their_url(accessor):
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
    (blob,) = await _list_files_dir(accessor, messages)
    assert blob.name == "report__F1ABC.pdf"
    assert blob.extra["file_id"] == "F1ABC"
    assert blob.size == 4096
    assert blob.extra["mimetype"] == "application/pdf"
    assert "url_private_download" in blob.extra
    assert blob.extra["filetype"] == "pdf"
    assert blob.extra["ts"] == "1712707200.0"


@pytest.mark.asyncio
async def test_files_dir_empty_on_no_attachments(accessor):
    messages = [
        {"type": "message", "user": "U1", "ts": "1712707200.0", "text": "hi"}
    ]
    assert await _list_files_dir(accessor, messages) == []
