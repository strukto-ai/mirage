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

from typing import Any

import pytest

import mirage.core.slack.read as read_mod
from mirage.policy.builtin.output_cap import ALL_COMMANDS
from mirage.types import Limit, MountMode
from mirage.vfs.slack.slack import SlackVFS
from mirage.workspace.workspace import Workspace
from tests.fixtures.slack_workspace import SlackWorkspace, slack_workspace

__all__ = ["slack_workspace"]


@pytest.fixture
def slack(slack_workspace: SlackWorkspace, monkeypatch):
    """Run a line over a Slack mount on the test's workspace.

    The days read are counted where a day's chat.jsonl is read: listing
    a day fetches its history too, the same request, so the requests
    alone cannot tell a read day from a listed one.

    Returns:
        an async ``run(line, walk_limit=None, **config)`` giving the
        output, the exit code, the channel days read and the queries
        searched; ``walk_limit`` is the mount's ``"*"`` command limit.
    """

    reads: list[str] = []
    history = read_mod.get_history_jsonl

    async def counted(accessor, channel_id, day, *args, **kwargs):
        reads.append(f"{channel_id}/{day}")
        return await history(accessor, channel_id, day, *args, **kwargs)

    monkeypatch.setattr(read_mod, "get_history_jsonl", counted)

    async def run(line: str, walk_limit: int | None = None, **config: Any):
        reads.clear()
        await slack_workspace.record()
        limits = (
            {}
            if walk_limit is None
            else {ALL_COMMANDS: Limit(walk_limit=walk_limit)}
        )
        vfs = SlackVFS(slack_workspace.config(**config))
        ws = Workspace(
            {"/slack": (vfs, MountMode.READ, limits)}, mode=MountMode.READ
        )
        try:
            result = await ws.shell(line)
            out = await result.stdout_str()
        finally:
            await ws.close()
        return (
            out,
            result.exit_code,
            sorted(reads),
            await slack_workspace.searches(),
        )

    return run
