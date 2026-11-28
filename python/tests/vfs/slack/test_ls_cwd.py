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

from mirage.types import MountMode
from mirage.vfs.slack.slack import SlackVFS
from mirage.workspace.workspace import Workspace


@pytest.mark.asyncio
async def test_ls_no_args_after_cd_returns_cwd_entries(slack_workspace):
    """Regression for bug: `ls` (no args) returned empty after `cd /slack/...`.

    Root cause: `slack/ls.py` rebuilt a fresh `PathSpec` from `cwd.virtual`
    without preserving the mount prefix, so readdir treated the mount prefix
    segment as a container name and returned [].
    """
    vfs = SlackVFS(slack_workspace.config())
    ws = Workspace({"/slack": vfs}, mode=MountMode.READ)
    try:
        r = await ws.shell("cd /slack/channels/general__C1")
        assert r.exit_code == 0
        r = await ws.shell("pwd")
        assert (await r.stdout_str()).strip() == "/slack/channels/general__C1"
        r = await ws.shell("ls")
        out = (await r.stdout_str()).strip()
    finally:
        await ws.close()
    assert r.exit_code == 0
    assert out != "", "ls no-args after cd returned empty"
    first_line = out.splitlines()[0]
    assert (
        len(first_line) == 10 and first_line[4] == "-" and first_line[7] == "-"
    )
