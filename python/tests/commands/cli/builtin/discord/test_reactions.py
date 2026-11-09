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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.cli.builtin.discord import DISCORD
from mirage.commands.cli.builtin.discord.reactions import reactions
from mirage.commands.config import Context
from mirage.core.discord.config import DiscordConfig
from mirage.io.types import materialize

ACCESSOR = DiscordAccessor(DiscordConfig(token="bot-token"))


@pytest.mark.asyncio
async def test_passes_the_flags_to_the_service(monkeypatch):
    seen = []

    async def fake(accessor, arg0, arg1):
        seen.append((arg0, arg1))
        return [{"emoji": "+1"}]

    monkeypatch.setitem(reactions.__globals__, "message_reactions", fake)
    spec = next(s for s in DISCORD.spec.subcommands if s.name == "reactions")
    out, _ = await reactions(
        ACCESSOR,
        [],
        [],
        Context(flags={"channel": "C1", "message": "M1"}, spec=spec),
    )
    assert seen == [("C1", "M1")]
    assert json.loads(await materialize(out)) == [{"emoji": "+1"}]
