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

from mirage.core.slack.post import upload_file
from tests.fixtures.slack_workspace import COMPLETE, UPLOAD_URL

# "lunch at noon" in general, the thread the file is posted in.
LUNCH = "1762214460.000001"


@pytest.mark.asyncio
async def test_upload_file_asks_sends_then_completes(slack_workspace):
    result = await upload_file(
        slack_workspace.accessor(), "C1", "reply.wav", b"RIFF", "here", LUNCH
    )
    [shared] = result["files"]
    assert shared["title"] == "reply.wav"
    assert await slack_workspace.run.params("GET", UPLOAD_URL) == [
        {"filename": "reply.wav", "length": "4"}
    ]
    assert await slack_workspace.run.bodies("POST", COMPLETE) == [
        {
            "files": [{"id": shared["id"], "title": "reply.wav"}],
            "channel_id": "C1",
            "initial_comment": "here",
            "thread_ts": LUNCH,
        }
    ]
    # The bytes sent to the upload URL are the file's.
    assert (
        await slack_workspace.run.read(f"/files/download/{shared['id']}")
        == b"RIFF"
    )
