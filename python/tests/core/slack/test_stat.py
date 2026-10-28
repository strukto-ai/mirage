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

from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import SlackApiError
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.vfs.slack import SlackVFS
from tests.fixtures.mounted import Mounted


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


DAY = "/channels/general__C001/2026-04-10"


def _blob(file_id: str, name: str, mimetype: str, size: int) -> dict:
    return {
        "id": file_id,
        "name": name,
        "mimetype": mimetype,
        "size": size,
        "url_private_download": "u",
    }


MESSAGES = [
    {
        "ts": "1775800000.000100",
        "text": "hi",
        "files": [
            _blob("F1", "report.pdf", "application/pdf", 4096),
            _blob("F2", "notes.txt", "text/plain", 128),
            _blob("F3", "data.bin", "application/octet-stream", 2048),
        ],
    }
]


@contextmanager
def _workspace(messages=MESSAGES, history_error=None):
    """The listings a walk of the workspace makes: one channel, one user,
    a day of ``messages``.
    """
    latest = datetime(2026, 4, 10, 12, tzinfo=timezone.utc).timestamp()
    with (
        patch(
            "mirage.core.slack.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=[
                {"id": "C001", "name": "general", "created": 1609459200}
            ],
        ),
        patch(
            "mirage.core.slack.readdir.list_users",
            new_callable=AsyncMock,
            return_value=[{"id": "U001", "name": "alice"}],
        ),
        patch(
            "mirage.core.slack.readdir._latest_message_ts",
            new_callable=AsyncMock,
            return_value=latest,
        ),
        patch(
            "mirage.core.slack.readdir.fetch_messages_for_day",
            new_callable=AsyncMock,
            return_value=messages,
            side_effect=history_error,
        ),
    ):
        yield


async def _stat_at(accessor: SlackAccessor, path: str):
    return await Mounted(SlackVFS, accessor).stat(path)


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_channel(accessor):
    with _workspace():
        result = await _stat_at(accessor, "/channels/general__C001")
    assert result.type == FileType.DIRECTORY
    assert result.extra["channel_id"] == "C001"
    assert result.modified == "2021-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_user(accessor):
    with _workspace():
        result = await _stat_at(accessor, "/users/alice__U001.json")
    assert result.content == ContentType.JSON
    assert result.extra["user_id"] == "U001"


@pytest.mark.asyncio
async def test_stat_jsonl(accessor):
    messages = [{"ts": "1775800000.000100", "text": "hello"}]
    with _workspace(messages):
        result = await _stat_at(accessor, f"{DAY}/chat.jsonl")
    assert result.content == ContentType.TEXT
    assert result.name == "chat.jsonl"
    assert result.size == len(b'{"ts":"1775800000.000100","text":"hello"}\n')


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(
                vfs_path="nonexistent/path",
                virtual="/nonexistent/path",
                directory="/nonexistent/path",
            ),
        )


@pytest.mark.asyncio
async def test_stat_date_dir(accessor):
    with _workspace():
        s = await _stat_at(accessor, DAY)
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_non_date_dir_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(
                vfs_path="channels/general__C001/notadate",
                virtual="/channels/general__C001/notadate",
                directory="/channels/general__C001/notadate",
            ),
        )


SEALED = SlackApiError(
    "Slack API error (conversations.history): not_in_channel"
)


@pytest.mark.asyncio
async def test_stat_chat_jsonl_absent_from_day_is_enoent(accessor):
    # A denied or empty day lists no chat.jsonl; stat must not fabricate
    # a sizeless file for it.
    with _workspace(history_error=SEALED):
        with pytest.raises(FileNotFoundError):
            await _stat_at(accessor, f"{DAY}/chat.jsonl")


@pytest.mark.asyncio
async def test_stat_files_dir(accessor):
    with _workspace():
        s = await _stat_at(accessor, f"{DAY}/files")
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_files_absent_from_day_is_enoent(accessor):
    # A sealed day lists nothing, so its files subdir does not exist.
    with _workspace(history_error=SEALED):
        with pytest.raises(FileNotFoundError):
            await _stat_at(accessor, f"{DAY}/files")


@pytest.mark.asyncio
async def test_stat_file_blob_pdf(accessor):
    with _workspace():
        s = await _stat_at(accessor, f"{DAY}/files/report__F1.pdf")
    assert s.content == ContentType.PDF
    assert s.size == 4096


@pytest.mark.asyncio
async def test_stat_file_blob_text(accessor):
    with _workspace():
        s = await _stat_at(accessor, f"{DAY}/files/notes__F2.txt")
    assert s.content == ContentType.TEXT


@pytest.mark.asyncio
async def test_stat_file_blob_unknown_mimetype_is_binary(accessor):
    with _workspace():
        s = await _stat_at(accessor, f"{DAY}/files/data__F3.bin")
    assert s.content == ContentType.BINARY
    assert s.size == 2048


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure(accessor):
    failure = RuntimeError("slack unavailable")
    with patch(
        "mirage.core.slack.readdir.list_channels",
        new_callable=AsyncMock,
        side_effect=failure,
    ):
        with pytest.raises(RuntimeError, match="slack unavailable"):
            await _stat_at(accessor, "/channels/missing__C999")
