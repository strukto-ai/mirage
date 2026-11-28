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

from mirage.vfs.slack import SlackVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

GENERAL = "/slack/channels/general__C1"
# The day general holds three attachments.
DAY = "2025-11-08"


async def _run(workspace, line: str) -> list[str]:
    ws = Workspace({"/slack/": vfs_over(SlackVFS, workspace.accessor())})
    result = await ws.shell(line)
    data = await result.stdout_str()
    await ws.close()
    return data.splitlines()


@pytest.mark.asyncio
async def test_type_f_lists_uploaded_files(slack_workspace):
    lines = await _run(slack_workspace, "find /slack/channels -type f")
    assert f"{GENERAL}/{DAY}/chat.jsonl" in lines
    assert f"{GENERAL}/{DAY}/files/report__F2.pdf" in lines
    assert f"{GENERAL}/{DAY}/files" not in lines


@pytest.mark.asyncio
async def test_type_d_lists_files_dir_not_blobs(slack_workspace):
    lines = await _run(slack_workspace, "find /slack/channels -type d")
    assert f"{GENERAL}/{DAY}/files" in lines
    assert f"{GENERAL}/{DAY}/files/report__F2.pdf" not in lines
