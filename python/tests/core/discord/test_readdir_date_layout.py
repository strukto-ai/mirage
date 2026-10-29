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
from tests.core.discord.conftest import (
    BROKEN_DAY,
    DAY,
    GONE_DAY,
    SEALED_DAY,
    THROTTLED_DAY,
)
from tests.fixtures.handed import call, entry_at
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio

CHANNEL = "My Server__G001/channels/general__C001"


async def readdir(accessor: DiscordAccessor, path: PathSpec) -> list[str]:
    return await mounted(DiscordVFS, accessor).readdir(path)


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def test_date_dir_contents_lists_chat_and_files(api, accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    assert result == [
        f"/{CHANNEL}/{DAY}/chat.jsonl",
        f"/{CHANNEL}/{DAY}/files",
    ]


async def test_files_dir_lists_attachments(api, accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert result == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]


async def test_a_day_discord_refuses_is_eacces(api, accessor):
    # A 403 is Discord declining to show the channel, not an empty day.
    day = f"/{CHANNEL}/{SEALED_DAY}"
    with pytest.raises(PermissionError) as raised:
        await readdir(accessor, spec(day))
    assert raised.value.filename.endswith(day)


async def test_a_day_of_a_vanished_channel_is_enoent(api, accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec(f"/{CHANNEL}/{GONE_DAY}"))


@pytest.mark.parametrize("day", [BROKEN_DAY, THROTTLED_DAY])
async def test_fetch_day_propagates_other_errors(api, accessor, day):
    with pytest.raises(ApiError):
        await readdir(accessor, spec(f"/{CHANNEL}/{day}"))


async def test_files_under_a_refused_day_is_eacces(api, accessor):
    with pytest.raises(PermissionError):
        await readdir(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/files"))


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


async def test_channel_glob_reaches_days_outside_the_window(api, accessor):
    # The bare listing is the 30 days up to the newest message, so a glob
    # for an older month sees nothing unless it pushes its own span down.
    result = await _globbed_listing(accessor, "2023-11-*")
    assert result[0] == f"/{CHANNEL}/2023-11-01"
    assert result[-1] == f"/{CHANNEL}/2023-11-30"
    assert len(result) == 30


async def test_channel_glob_is_clipped_at_the_newest_message(api, accessor):
    # The fixture channel's last message is 2024-01-15, and nothing was
    # posted after it, so the rest of January is not listed.
    result = await _globbed_listing(accessor, "2024-01-*")
    assert result[-1] == f"/{CHANNEL}/2024-01-15"
    assert len(result) == 15


async def test_a_globbed_channel_listing_is_not_the_directory(api, accessor):
    # The glob's answer must not stand in for the channel: a later bare
    # listing still reports the recent window.
    await readdir(accessor, globbed(f"/{CHANNEL}", "2023-11-*"))
    result = await readdir(accessor, spec(f"/{CHANNEL}"))
    assert result[-1] == f"/{CHANNEL}/2024-01-15"
    assert len(result) == 30


async def test_a_channel_listing_is_a_window(api, accessor):
    # The channel lists the last 30 days: not the backend saying anything
    # outside them is gone.
    channel = await call(
        discord_readdir, discord_readdir, accessor, spec(f"/{CHANNEL}")
    )
    assert channel.window is True
