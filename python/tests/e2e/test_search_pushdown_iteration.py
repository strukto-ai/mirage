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

from mirage import MountMode, Workspace
from mirage.types import ContentType, FileStat, FileType
from mirage.vfs.slack import SlackConfig, SlackVFS

DAYS = [f"2026-{m:02d}-{d:02d}" for m in range(1, 5) for d in range(1, 16)]


@pytest.mark.asyncio
async def test_slack_grep_glob_expanded_to_60_paths_reads_those_60_days():
    # This line used to become ONE channel-wide search: `coalesce_scopes`
    # folded the 60 same-channel operands into a channel scope, and
    # `build_query` carries only `in:#general` with no date. So the answer
    # covered every day the channel ever had — including the ones the glob
    # did not match, since slack search also reaches past the browse window.
    # It is 60 named files: read them. The saving was real and is gone with
    # it; the answer it bought was not the question asked.
    slack = SlackVFS(
        config=SlackConfig(token="xoxb-test", search_token="xoxp-test"))
    ws = Workspace({"/slack": (slack, MountMode.READ)}, mode=MountMode.READ)
    expanded = " ".join(f"/slack/channels/general__C1/{day}/chat.jsonl"
                        for day in DAYS)
    read = AsyncMock(return_value=b'{"text":"hello there"}\n')
    stat = AsyncMock(return_value=FileStat(name="chat.jsonl",
                                           type=FileType.FILE,
                                           content=ContentType.TEXT,
                                           size=23))
    try:
        with patch(
                "mirage.commands.builtin.slack.grep.search_messages",
                new=AsyncMock(),
        ) as fake_search, patch(
                "mirage.commands.builtin.slack.grep.slack_read",
                new=read), patch("mirage.commands.builtin.slack.grep._stat",
                                 new=stat):
            result = await ws.shell(f"grep -iw hello {expanded}")
        fake_search.assert_not_awaited()
        assert read.await_count == len(DAYS)
        assert result.exit_code == 0
        out = (result.stdout or b"").decode()
        assert out.count("hello there") == len(DAYS)
        # Every line names an operand the command line actually carried.
        assert f"/slack/channels/general__C1/{DAYS[0]}/chat.jsonl:" in out
        assert f"/slack/channels/general__C1/{DAYS[-1]}/chat.jsonl:" in out
    finally:
        await ws.close()
