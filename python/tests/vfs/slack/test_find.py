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
from mirage.core.slack.config import SlackConfig
from mirage.vfs.slack import SlackVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

GENERAL = "/slack/channels/general__C1"


FILE_CHANNELS = [{"id": "C1", "name": "general", "created": 1700000000}]

FILE_MESSAGES = [
    {
        "ts": "1700000000.000100",
        "text": "here you go",
        "files": [
            {
                "id": "F1",
                "name": "report.pdf",
                "url_private_download": "https://files.slack.com/x",
                "size": 10,
                "timestamp": 1700000000,
                "mimetype": "application/pdf",
            }
        ],
    }
]

DAY = "2023-11-14"


async def _run_with_files(line: str) -> list[str]:
    accessor = SlackAccessor(SlackConfig(token="xoxb-test"))
    ws = Workspace({"/slack/": vfs_over(SlackVFS, accessor)})
    with (
        patch(
            "mirage.core.slack.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=FILE_CHANNELS,
        ),
        patch(
            "mirage.core.slack.readdir._latest_message_ts",
            new_callable=AsyncMock,
            return_value=1700000000.0001,
        ),
        patch(
            "mirage.core.slack.readdir.fetch_messages_for_day",
            new_callable=AsyncMock,
            return_value=FILE_MESSAGES,
        ),
    ):
        result = await ws.shell(line)
        data = await result.stdout_str()
    await ws.close()
    return data.splitlines()


@pytest.mark.asyncio
async def test_type_f_lists_uploaded_files():
    lines = await _run_with_files("find /slack/channels -type f")
    assert f"{GENERAL}/{DAY}/chat.jsonl" in lines
    assert f"{GENERAL}/{DAY}/files/report__F1.pdf" in lines
    assert f"{GENERAL}/{DAY}/files" not in lines


@pytest.mark.asyncio
async def test_type_d_lists_files_dir_not_blobs():
    lines = await _run_with_files("find /slack/channels -type d")
    assert f"{GENERAL}/{DAY}/files" in lines
    assert f"{GENERAL}/{DAY}/files/report__F1.pdf" not in lines
