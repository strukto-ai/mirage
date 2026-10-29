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
from mirage.core.slack.post import upload_file

ACCESSOR = SlackAccessor(SlackConfig(token="xoxb-test"))


@pytest.mark.asyncio
async def test_upload_file_asks_sends_then_completes():
    ticket = {
        "ok": True,
        "upload_url": "https://files.example/u/1",
        "file_id": "F1",
    }
    shared = {"ok": True, "files": [{"id": "F1", "title": "reply.wav"}]}
    with (
        patch(
            "mirage.core.slack.post.slack_get",
            new=AsyncMock(return_value=ticket),
        ) as get,
        patch("mirage.core.slack.post.upload_bytes", new=AsyncMock()) as send,
        patch(
            "mirage.core.slack.post.slack_post",
            new=AsyncMock(return_value=shared),
        ) as complete,
    ):
        result = await upload_file(
            ACCESSOR, "C1", "reply.wav", b"RIFF", "here", "9.9"
        )
    assert result == shared
    get.assert_awaited_once_with(
        ACCESSOR,
        "files.getUploadURLExternal",
        {"filename": "reply.wav", "length": 4},
    )
    send.assert_awaited_once_with(
        ACCESSOR, "https://files.example/u/1", b"RIFF"
    )
    complete.assert_awaited_once_with(
        ACCESSOR,
        "files.completeUploadExternal",
        {
            "files": [{"id": "F1", "title": "reply.wav"}],
            "channel_id": "C1",
            "initial_comment": "here",
            "thread_ts": "9.9",
        },
    )
