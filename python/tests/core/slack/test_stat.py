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

from mirage.core.slack.client import SlackApiError
from mirage.core.slack.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.vfs.slack import SlackVFS
from tests.fixtures.mounted import Mounted
from tests.fixtures.slack_workspace import HISTORY, LISTING

# The day general holds three attachments: a PDF, a text file and one of
# no type Slack names.
DAY = "/channels/general__C1/2025-11-08"
UNTIL_CLEARED = 1_000_000


def _mounted(workspace) -> Mounted:
    return Mounted(SlackVFS, workspace.accessor())


async def _refuse_history(workspace) -> None:
    await workspace.run.answer_next(
        "GET",
        HISTORY,
        200,
        {"ok": False, "error": "not_in_channel"},
        times=UNTIL_CLEARED,
    )


@pytest.mark.asyncio
async def test_stat_root(slack_workspace):
    result = await stat(
        slack_workspace.accessor(),
        PathSpec(vfs_path="", virtual="/", directory="/"),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_channel(slack_workspace):
    result = await _mounted(slack_workspace).stat("/channels/general__C1")
    assert result.type == FileType.DIRECTORY
    assert result.extra["channel_id"] == "C1"
    # A channel is dated by its creation.
    assert result.modified == "2025-11-03T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_user(slack_workspace):
    result = await _mounted(slack_workspace).stat("/users/ana__U1.json")
    assert result.content == ContentType.JSON
    assert result.extra["user_id"] == "U1"


@pytest.mark.asyncio
async def test_stat_jsonl(slack_workspace):
    mounted = _mounted(slack_workspace)
    chat = "/channels/general__C1/2025-11-04/chat.jsonl"
    result = await mounted.stat(chat)
    assert result.content == ContentType.TEXT
    assert result.name == "chat.jsonl"
    assert result.size == len(await mounted.read(chat))


@pytest.mark.asyncio
async def test_stat_not_found(slack_workspace):
    with pytest.raises(FileNotFoundError):
        await stat(
            slack_workspace.accessor(),
            PathSpec(
                vfs_path="nonexistent/path",
                virtual="/nonexistent/path",
                directory="/nonexistent/path",
            ),
        )


@pytest.mark.asyncio
async def test_stat_date_dir(slack_workspace):
    s = await _mounted(slack_workspace).stat(DAY)
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_non_date_dir_not_found(slack_workspace):
    with pytest.raises(FileNotFoundError):
        await stat(
            slack_workspace.accessor(),
            PathSpec(
                vfs_path="channels/general__C1/notadate",
                virtual="/channels/general__C1/notadate",
                directory="/channels/general__C1/notadate",
            ),
        )


@pytest.mark.asyncio
async def test_stat_chat_jsonl_in_a_refused_day_is_eacces(slack_workspace):
    # A day Slack will not show is not an empty day; stat must neither
    # fabricate a sizeless file nor call it absent.
    mounted = _mounted(slack_workspace)
    await mounted.readdir("/channels/general__C1")
    await _refuse_history(slack_workspace)
    with pytest.raises(PermissionError):
        await mounted.stat(f"{DAY}/chat.jsonl")


@pytest.mark.asyncio
async def test_stat_files_dir(slack_workspace):
    s = await _mounted(slack_workspace).stat(f"{DAY}/files")
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_files_in_a_refused_day_is_eacces(slack_workspace):
    mounted = _mounted(slack_workspace)
    await mounted.readdir("/channels/general__C1")
    await _refuse_history(slack_workspace)
    with pytest.raises(PermissionError):
        await mounted.stat(f"{DAY}/files")


@pytest.mark.asyncio
async def test_stat_file_blob_pdf(slack_workspace):
    s = await _mounted(slack_workspace).stat(f"{DAY}/files/report__F2.pdf")
    assert s.content == ContentType.PDF
    assert s.size == len(b"%PDF-1.4 the report\n")


@pytest.mark.asyncio
async def test_stat_file_blob_text(slack_workspace):
    s = await _mounted(slack_workspace).stat(f"{DAY}/files/notes__F3.txt")
    assert s.content == ContentType.TEXT


@pytest.mark.asyncio
async def test_stat_file_blob_unknown_mimetype_is_binary(slack_workspace):
    s = await _mounted(slack_workspace).stat(f"{DAY}/files/data__F4.bin")
    assert s.content == ContentType.BINARY
    assert s.size == len(b"0101")


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure(slack_workspace):
    await slack_workspace.run.answer_next(
        "GET", LISTING, 200, {"ok": False, "error": "fatal_error"}
    )
    with pytest.raises(SlackApiError, match="fatal_error"):
        await _mounted(slack_workspace).stat("/channels/missing__C999")
