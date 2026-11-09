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
from mirage.commands.cli.builtin.discord.list_pins import list_pins
from mirage.commands.config import Context
from mirage.core.discord.config import DiscordConfig
from mirage.io.types import materialize

ACCESSOR = DiscordAccessor(DiscordConfig(token="bot-token"))


@pytest.mark.asyncio
async def test_passes_the_flags_to_the_service(monkeypatch):
    seen = []

    async def fake(accessor, arg0):
        seen.append((arg0,))
        return [{"id": "M1"}]

    monkeypatch.setitem(list_pins.__globals__, "list_pins_core", fake)
    spec = next(s for s in DISCORD.spec.subcommands if s.name == "list-pins")
    out, _ = await list_pins(
        ACCESSOR, [], [], Context(flags={"channel": "C1"}, spec=spec)
    )
    assert seen == [("C1",)]
    assert json.loads(await materialize(out)) == [{"id": "M1"}]
