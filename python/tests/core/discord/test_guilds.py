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

import pytest

from mirage.core.discord.guilds import list_guilds
from tests.fixtures.discord_guild import GUILD, GUILDS


@pytest.mark.asyncio
async def test_list_guilds(discord_guild):
    result = await list_guilds(discord_guild.accessor())
    assert [(g["id"], g["name"]) for g in result] == [(GUILD, "My Server")]
    [params] = await discord_guild.run.params("GET", GUILDS)
    assert (params["after"], params["limit"]) == ("0", "200")
