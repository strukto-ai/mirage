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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.cli.builtin.slack import SLACK
from mirage.commands.cli.builtin.slack.edit_message import edit_message
from mirage.commands.config import Context
from mirage.core.slack.config import SlackConfig
from mirage.io.types import materialize

ACCESSOR = SlackAccessor(SlackConfig(token="xoxb-test"))


@pytest.mark.asyncio
async def test_edits_the_named_message(monkeypatch):
    seen = []

    async def fake(accessor, channel, ts, text):
        seen.append((channel, ts, text))
        return {"ok": True, "ts": ts}

    monkeypatch.setitem(edit_message.__globals__, "edit_message_core", fake)
    spec = next(s for s in SLACK.spec.subcommands if s.name == "edit-message")
    out, _ = await edit_message(
        ACCESSOR,
        [],
        [],
        Context(
            flags={"channel": "C1", "ts": "1.5", "text": "new"}, spec=spec
        ),
    )
    assert seen == [("C1", "1.5", "new")]
    assert json.loads(await materialize(out)) == {"ok": True, "ts": "1.5"}
