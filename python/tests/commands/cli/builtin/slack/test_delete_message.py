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
from mirage.commands.cli.builtin.slack.delete_message import delete_message
from mirage.commands.config import Context
from mirage.core.slack.config import SlackConfig
from mirage.io.types import materialize

ACCESSOR = SlackAccessor(SlackConfig(token="xoxb-test"))


@pytest.mark.asyncio
async def test_deletes_the_named_message(monkeypatch):
    seen = []

    async def fake(accessor, channel, ts):
        seen.append((channel, ts))
        return {"ok": True}

    monkeypatch.setitem(
        delete_message.__globals__, "delete_message_core", fake
    )
    spec = next(
        s for s in SLACK.spec.subcommands if s.name == "delete-message"
    )
    out, _ = await delete_message(
        ACCESSOR,
        [],
        [],
        Context(flags={"channel": "C1", "ts": "1.5"}, spec=spec),
    )
    assert seen == [("C1", "1.5")]
    assert json.loads(await materialize(out)) == {"ok": True}
