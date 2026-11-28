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

import json

import pytest

from mirage.commands.cli.builtin.slack import SLACK
from mirage.commands.cli.builtin.slack.edit_message import edit_message
from mirage.commands.config import Context
from mirage.io.types import materialize


@pytest.mark.asyncio
async def test_edits_the_named_message(slack_workspace):
    # A bot token may change only what the bot posted.
    ts = await slack_workspace.post("C1", "old")
    spec = next(s for s in SLACK.spec.subcommands if s.name == "edit-message")
    out, _ = await edit_message(
        slack_workspace.accessor(),
        [],
        [],
        Context(flags={"channel": "C1", "ts": ts, "text": "new"}, spec=spec),
    )
    answer = json.loads(await materialize(out))
    assert (answer["ok"], answer["ts"]) == (True, ts)
    [edited] = [
        m for m in await slack_workspace.history("C1") if m["ts"] == ts
    ]
    assert edited["text"] == "new"
