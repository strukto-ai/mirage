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
from mirage.resource.slack import SlackConfig, SlackResource


@pytest.mark.asyncio
async def test_slack_grep_glob_expanded_to_60_paths_is_one_native_call():
    slack = SlackResource(
        config=SlackConfig(token="xoxb-test", search_token="xoxp-test"))
    ws = Workspace({"/slack": (slack, MountMode.READ)}, mode=MountMode.READ)
    fake_payload = (b'{"messages":{"matches":[{"channel":{"name":"general",'
                    b'"id":"C1"},"ts":"1700000000.0","text":"hello"}]}}')
    expanded = " ".join(
        f"/slack/channels/general__C1/2026-{m:02d}-{d:02d}/chat.jsonl"
        for m in range(1, 5) for d in range(1, 16))
    try:
        with patch(
                "mirage.commands.builtin.slack.grep.search_messages",
                new=AsyncMock(return_value=fake_payload),
        ) as fake_search:
            result = await ws.execute(f"grep -i hello {expanded}")
        assert fake_search.await_count == 1
        assert result.exit_code == 0
        assert b"hello" in (result.stdout or b"")
    finally:
        await ws.close()
