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

from unittest.mock import patch

import pytest

from mirage.resource.slack.config import SlackConfig
from mirage.resource.slack.slack import SlackResource
from mirage.types import MountMode
from mirage.workspace.workspace import Workspace


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test")


@pytest.mark.asyncio
async def test_ls_no_args_after_cd_returns_cwd_entries(config):
    """Regression for bug: `ls` (no args) returned empty after `cd /slack/...`.

    Root cause: `slack/ls.py` rebuilt a fresh `PathSpec` from `cwd.original`
    without preserving the mount prefix, so readdir treated the mount prefix
    segment as a container name and returned [].
    """
    resource = SlackResource(config)
    ws = Workspace({"/slack": resource}, mode=MountMode.READ)
    channels_page = {
        "channels": [{
            "id": "C001",
            "name": "general",
            "created": 1700000000
        }],
        "response_metadata": {
            "next_cursor": ""
        },
    }
    history_page = {
        "messages": [{
            "ts": "1700050000.0",
            "text": "hi"
        }],
        "has_more": False,
    }

    async def fake_get(_cfg, method, params=None, token=None):
        if method == "conversations.list":
            return channels_page
        if method == "conversations.history":
            return history_page
        raise AssertionError(f"unexpected method: {method}")

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get), \
         patch("mirage.core.slack.readdir.slack_get", new=fake_get):
        r = await ws.execute("cd /slack/channels/general__C001")
        assert r.exit_code == 0
        r = await ws.execute("pwd")
        assert (await
                r.stdout_str()).strip() == "/slack/channels/general__C001"

        r = await ws.execute("ls")
        out = (await r.stdout_str()).strip()
    assert r.exit_code == 0
    assert out != "", "ls no-args after cd returned empty"
    first_line = out.splitlines()[0]
    assert len(
        first_line) == 10 and first_line[4] == "-" and first_line[7] == "-"
