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


@pytest.mark.asyncio
async def test_a_glob_over_a_days_files_matches_their_names(slack_workspace):
    # 2025-11-08 in general holds report.pdf, notes.txt and data.bin.
    ws = Workspace({"/slack/": vfs_over(SlackVFS, slack_workspace.accessor())})
    result = await ws.shell(
        "echo /slack/channels/general__C1/2025-11-08/files/*.pdf"
    )
    matched = (await result.stdout_str()).split()
    await ws.close()
    assert matched == [
        "/slack/channels/general__C1/2025-11-08/files/report__F2.pdf"
    ]
