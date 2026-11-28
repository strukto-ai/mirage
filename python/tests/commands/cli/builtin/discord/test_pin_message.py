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

from mirage.commands.cli.builtin.discord import DISCORD
from mirage.commands.cli.builtin.discord.pin_message import pin_message
from mirage.commands.config import Context
from mirage.io.types import materialize
from tests.fixtures.discord_guild import DAY, GENERAL


async def _out(result) -> object:
    out, _ = result
    return json.loads(await materialize(out))


def _spec(leaf: str):
    return next(s for s in DISCORD.spec.subcommands if s.name == leaf)


@pytest.mark.asyncio
async def test_passes_the_flags_to_the_service(discord_guild):
    [hello, _] = await discord_guild.day(GENERAL, DAY)
    flags = {"channel": GENERAL, "message": hello["id"]}
    out = await pin_message(
        discord_guild.accessor(),
        [],
        [],
        Context(flags=flags, spec=_spec("pin-message")),
    )
    assert await _out(out) == {"ok": True}
    assert (await discord_guild.message(GENERAL, hello["id"]))[
        "pinned"
    ] is True
