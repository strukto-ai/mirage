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

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.core.hierarchy.probe import rows_of
from mirage.core.slack.readdir import _date_range, readdir
from mirage.core.time_range import TimeRange
from mirage.types import DirListing, FileStat, FileType, PathSpec
from tests.fixtures.slack_workspace import HISTORY

# general is created on 2025-11-03 and its latest message is on 11-08.
START = 1762128000


def _channel(
    dirname: str = "general__C1", created: int = START, name: str = "general"
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


def _day(name: str) -> FileStat:
    return FileStat(
        name=name, type=FileType.DIRECTORY, extra={"channel_id": "C1"}
    )


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


def _paths(listed: list[FileStat] | DirListing, folder: str) -> list[str]:
    return [f"{folder.rstrip('/')}/{row.name}" for row in rows_of(listed)]


@pytest.mark.asyncio
async def test_readdir_root(slack_workspace):
    result = await readdir(slack_workspace.accessor(), _spec("/"))
    assert _paths(result, "/") == ["/channels", "/dms", "/users"]


@pytest.mark.asyncio
async def test_readdir_channels(slack_workspace):
    result = _paths(
        await readdir(slack_workspace.accessor(), _spec("/channels")),
        "/channels",
    )
    assert result == ["/channels/general__C1", "/channels/random__C2"]


@pytest.mark.asyncio
async def test_readdir_users(slack_workspace):
    # The people only: the bot, the deactivated user and Slackbot are not
    # listed.
    result = _paths(
        await readdir(slack_workspace.accessor(), _spec("/users")), "/users"
    )
    assert result == ["/users/ana__U1.json", "/users/ben__U2.json"]


@pytest.mark.asyncio
async def test_readdir_channel_dates(slack_workspace):
    listed = await readdir(
        slack_workspace.accessor(), _spec("/channels/general__C1"), _channel()
    )
    result = _paths(listed, "/channels/general__C1")
    # Newest first, from the day of the latest message back to creation.
    assert [r.rsplit("/", 1)[1] for r in result] == [
        "2025-11-08",
        "2025-11-07",
        "2025-11-06",
        "2025-11-05",
        "2025-11-04",
        "2025-11-03",
    ]
    assert listed.entries[0].extra == {"channel_id": "C1"}
    assert await slack_workspace.run.params("GET", HISTORY) == [
        {"channel": "C1", "limit": "1"}
    ]


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
async def test_readdir_channels_keeps_created(slack_workspace):
    rows = await readdir(slack_workspace.accessor(), _spec("/channels"))
    general = next(row for row in rows if row.name == "general__C1")
    assert general.extra["created"] == START
    assert general.modified is not None


@pytest.mark.asyncio
async def test_readdir_channel_dates_with_created(slack_workspace):
    # Created two years before its latest message, so the listing is the
    # last 90 days only.
    listed = await readdir(
        slack_workspace.accessor(),
        _spec("/channels/general__C1"),
        _channel(created=1700000000),
    )
    result = _paths(listed, "/channels/general__C1")
    assert len(result) == 90
    assert all(not r.endswith(".jsonl") for r in result)
    assert result[0].endswith("2025-11-08")


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_chat_and_files(slack_workspace):
    # 2025-11-07 holds no general message.
    listed = await readdir(
        slack_workspace.accessor(),
        _spec("/channels/general__C1/2025-11-07"),
        _day("2025-11-07"),
    )
    assert sorted(_paths(listed, "/channels/general__C1/2025-11-07")) == [
        "/channels/general__C1/2025-11-07/chat.jsonl",
        "/channels/general__C1/2025-11-07/files",
    ]


@pytest.mark.asyncio
async def test_readdir_skips_unreadable_file_payloads(slack_workspace):
    # Tombstoned and access-restricted file payloads carry an id but no
    # download URL and no size; they must not be listed, or sizes_always_known
    # would be false and read() would ENOENT on a listed file. Slack's own
    # page for the day, with two of its three files made so.
    page = await slack_workspace.run.call(
        "GET",
        HISTORY,
        params={
            "channel": "C1",
            "oldest": "1762560000",
            "latest": "1762646400",
            "inclusive": "true",
        },
    )
    files = page["messages"][0]["files"]
    files[1] = {"id": files[1]["id"], "mode": "tombstone"}
    files[2] = {
        "id": files[2]["id"],
        "name": files[2]["name"],
        "file_access": "check_file_info",
    }
    await slack_workspace.run.answer_next("GET", HISTORY, 200, page)
    listed = await readdir(
        slack_workspace.accessor(),
        _spec("/channels/general__C1/2025-11-08"),
        _day("2025-11-08"),
    )
    (blob,) = listed.seeds["files"]
    assert blob.name == "report__F2.pdf"
    assert blob.size == len(b"%PDF-1.4 the report\n")


# ana's DM: a message on 2025-11-03 and one on 11-06. Its row names no
# creation, so a bare listing must find the first message.
DM = _channel("ana__D1", created=0, name="ana")
END = "2025-11-05T00:00:00Z"


def _scoped(workspace) -> SlackAccessor:
    return SlackAccessor(workspace.config(), TimeRange.from_strings(None, END))


@pytest.mark.asyncio
async def test_end_scoped_glob_listing_skips_the_history_scan(
    slack_workspace,
):
    listed = await readdir(
        _scoped(slack_workspace),
        PathSpec(
            virtual="/dms/ana__D1/2025-10-*",
            directory="/dms/ana__D1/",
            vfs_path="dms/ana__D1/2025-10-*",
            pattern="2025-10-*",
        ),
        DM,
    )
    # Only the latest message is asked for, never the history before it.
    assert await slack_workspace.run.params("GET", HISTORY) == [
        {"channel": "D1", "limit": "1"}
    ]
    result = _paths(listed, "/dms/ana__D1")
    assert len(result) == 31
    assert result[0] == "/dms/ana__D1/2025-10-31"
    assert result[-1] == "/dms/ana__D1/2025-10-01"


@pytest.mark.asyncio
async def test_end_scoped_bare_listing_pages_only_history_before_the_end(
    slack_workspace,
):
    listed = await readdir(_scoped(slack_workspace), _spec("/dms/ana__D1"), DM)
    end = datetime(2025, 11, 5, tzinfo=timezone.utc).timestamp()
    assert await slack_workspace.run.params("GET", HISTORY) == [
        {"channel": "D1", "limit": "1"},
        {"channel": "D1", "limit": "200", "latest": f"{end:.6f}"},
    ]
    assert _paths(listed, "/dms/ana__D1") == [
        "/dms/ana__D1/2025-11-04",
        "/dms/ana__D1/2025-11-03",
    ]


@pytest.mark.asyncio
async def test_a_channel_listing_is_a_window(slack_workspace):
    # The bare listing covers the last 90 days only; a day that falls out
    # of it still exists and is still readable by path.
    listed = await readdir(
        slack_workspace.accessor(), _spec("/channels/general__C1"), _channel()
    )
    assert listed.window is True


async def _list_files_dir(workspace, day: str) -> list[FileStat]:
    files = FileStat(
        name="files",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C1", "date": day},
    )
    folder = f"/channels/general__C1/{day}/files"
    return rows_of(await readdir(workspace.accessor(), _spec(folder), files))


@pytest.mark.asyncio
async def test_files_dir_lists_attachments_and_keeps_their_url(
    slack_workspace,
):
    blobs = await _list_files_dir(slack_workspace, "2025-11-08")
    assert [b.name for b in blobs] == [
        "report__F2.pdf",
        "notes__F3.txt",
        "data__F4.bin",
    ]
    report = blobs[0]
    assert report.extra["file_id"] == "F2"
    assert report.size == len(b"%PDF-1.4 the report\n")
    assert report.extra["mimetype"] == "application/pdf"
    assert report.extra["url_private_download"].endswith("/files/download/F2")
    assert report.extra["filetype"] == "pdf"
    assert report.extra["ts"] == "1762560060.000001"


@pytest.mark.asyncio
async def test_files_dir_empty_on_no_attachments(slack_workspace):
    # 2025-11-04 holds "lunch at noon" and no file.
    assert await _list_files_dir(slack_workspace, "2025-11-04") == []
