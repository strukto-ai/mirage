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

from mirage.accessor.discord import DiscordAccessor
from mirage.core.api.errors import ApiError
from mirage.core.discord.readdir import readdir as discord_readdir
from mirage.types import PathSpec
from mirage.vfs.discord import DiscordVFS
from tests.fixtures.discord_guild import DAY, GUILD_DIR, MESSAGES
from tests.fixtures.handed import call, entry_at
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio

CHANNEL = f"{GUILD_DIR}/channels/general__211"
# Any day a refusal is armed for: Discord refuses the channel, not the day.
REFUSED_DAY = "2024-01-13"


async def readdir(accessor: DiscordAccessor, path: PathSpec) -> list[str]:
    return await mounted(DiscordVFS, accessor).readdir(path)


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def test_date_dir_contents_lists_chat_and_files(accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    assert result == [
        f"/{CHANNEL}/{DAY}/chat.jsonl",
        f"/{CHANNEL}/{DAY}/files",
    ]


async def test_files_dir_lists_attachments(accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert result == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]


async def test_a_day_discord_refuses_is_eacces(discord_guild, accessor):
    # A 403 is Discord declining to show the channel, not an empty day.
    await discord_guild.refuse(MESSAGES, 403)
    day = f"/{CHANNEL}/{REFUSED_DAY}"
    with pytest.raises(PermissionError) as raised:
        await readdir(accessor, spec(day))
    assert raised.value.filename.endswith(day)


async def test_a_day_of_a_vanished_channel_is_enoent(discord_guild, accessor):
    await discord_guild.refuse(MESSAGES, 404)
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}"))


@pytest.mark.parametrize("status", [500, 429])
async def test_fetch_day_propagates_other_errors(
    discord_guild, accessor, status
):
    await discord_guild.refuse(MESSAGES, status)
    with pytest.raises(ApiError):
        await readdir(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}"))


async def test_files_under_a_refused_day_is_eacces(discord_guild, accessor):
    await discord_guild.refuse(MESSAGES, 403)
    with pytest.raises(PermissionError):
        await readdir(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}/files"))


def globbed(virtual: str, pattern: str) -> PathSpec:
    return PathSpec(
        virtual=f"{virtual}/{pattern}",
        directory=f"{virtual}/",
        vfs_path=f"{virtual.lstrip('/')}/{pattern}",
        pattern=pattern,
    )


async def _globbed_listing(
    accessor: DiscordAccessor, pattern: str
) -> list[str]:
    """The backend's own listing for a glob word: the span it asks for,
    before a shell matches names against it.
    """
    channel = await entry_at(discord_readdir, accessor, spec(f"/{CHANNEL}"))
    listed = await discord_readdir(
        accessor, globbed(f"/{CHANNEL}", pattern), channel
    )
    assert listed.partial is True
    return [f"/{CHANNEL}/{row.name}" for row in listed.entries]


async def test_channel_glob_reaches_days_outside_the_window(accessor):
    # The bare listing is the 30 days up to the newest message, so a glob
    # for an older month sees nothing unless it pushes its own span down.
    result = await _globbed_listing(accessor, "2023-11-*")
    assert result[0] == f"/{CHANNEL}/2023-11-01"
    assert result[-1] == f"/{CHANNEL}/2023-11-30"
    assert len(result) == 30


async def test_channel_glob_is_clipped_at_the_newest_message(accessor):
    # general's last message is 2024-01-16, and nothing was posted after
    # it, so the rest of January is not listed.
    result = await _globbed_listing(accessor, "2024-01-*")
    assert result[-1] == f"/{CHANNEL}/2024-01-16"
    assert len(result) == 16


async def test_a_globbed_channel_listing_is_not_the_directory(accessor):
    # The glob's answer must not stand in for the channel: a later bare
    # listing still reports the recent window.
    await readdir(accessor, globbed(f"/{CHANNEL}", "2023-11-*"))
    result = await readdir(accessor, spec(f"/{CHANNEL}"))
    assert result[-1] == f"/{CHANNEL}/2024-01-16"
    assert len(result) == 30


async def test_a_channel_listing_is_a_window(accessor):
    # The channel lists the last 30 days: not the backend saying anything
    # outside them is gone.
    channel = await call(
        discord_readdir, discord_readdir, accessor, spec(f"/{CHANNEL}")
    )
    assert channel.window is True
