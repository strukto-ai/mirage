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
from mirage.core.slack.config import SlackConfig
from mirage.vfs.slack import SlackVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


def _blob(file_id: str, name: str, mimetype: str) -> dict:
    return {
        "id": file_id,
        "name": name,
        "mimetype": mimetype,
        "size": 1,
        "url_private_download": "u",
    }


@pytest.mark.asyncio
async def test_a_glob_over_a_days_files_matches_their_names():
    accessor = SlackAccessor(config=SlackConfig(token="xoxb"))
    ws = Workspace({"/slack/": vfs_over(SlackVFS, accessor)})
    latest = datetime(2026, 4, 10, 12, tzinfo=timezone.utc).timestamp()
    messages = [
        {
            "ts": "1775800000.000100",
            "files": [
                _blob("F1", "a.pdf", "application/pdf"),
                _blob("F2", "b.txt", "text/plain"),
            ],
        }
    ]
    with (
        patch(
            "mirage.core.slack.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=[{"id": "C001", "name": "general", "created": 1}],
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
        ),
    ):
        result = await ws.shell(
            "echo /slack/channels/general__C001/2026-04-10/files/*.pdf"
        )
        matched = (await result.stdout_str()).split()
    await ws.close()
    assert matched == [
        "/slack/channels/general__C001/2026-04-10/files/a__F1.pdf"
    ]
