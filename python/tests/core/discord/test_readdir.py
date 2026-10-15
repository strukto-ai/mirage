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

import re

import pytest

import mirage.core.discord.readdir as readdir_mod
from mirage.accessor.discord import DiscordAccessor
from mirage.core.render.json import compact_json_bytes, jsonl_bytes
from mirage.types import FileStat, PathSpec
from mirage.vfs.discord import DiscordVFS
from tests.core.discord.conftest import DAY, MEMBERS, MESSAGES
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio

GUILD_DIR = "My Server__G001"
CHANNEL = f"{GUILD_DIR}/channels/general__C001"


async def readdir(accessor: DiscordAccessor, path: PathSpec) -> list[str]:
    return await mounted(DiscordVFS, accessor).readdir(path)


async def stat(accessor: DiscordAccessor, path: PathSpec) -> FileStat:
    return await mounted(DiscordVFS, accessor).stat(path)


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def test_readdir_root(api, accessor):
    result = await readdir(accessor, spec("/"))
    assert result == [f"/{GUILD_DIR}"]


async def test_readdir_root_with_slash_in_name(api, accessor, monkeypatch):
    async def guilds(config, session=None):
        return [{"id": "G001", "name": "A/B Test Server"}]

    monkeypatch.setattr(readdir_mod, "list_guilds", guilds)
    result = await readdir(accessor, spec("/"))
    assert result == ["/A∕B Test Server__G001"]


async def test_readdir_root_with_apostrophe(api, accessor, monkeypatch):
    async def guilds(config, session=None):
        return [{"id": "G001", "name": "Zecheng's Server"}]

    monkeypatch.setattr(readdir_mod, "list_guilds", guilds)
    result = await readdir(accessor, spec("/"))
    assert result == ["/Zecheng's Server__G001"]


async def test_readdir_guild(api, accessor):
    result = await readdir(accessor, spec(f"/{GUILD_DIR}"))
    assert result == [
        f"/{GUILD_DIR}/channels",
        f"/{GUILD_DIR}/members",
    ]


async def test_readdir_bogus_guild_is_enoent(api, accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/Nope__G9"))


async def test_readdir_channels(api, accessor):
    result = await readdir(accessor, spec(f"/{GUILD_DIR}/channels"))
    assert f"/{GUILD_DIR}/channels/general__C001" in result
    assert f"/{GUILD_DIR}/channels/random__C002" in result


async def test_readdir_channel_dates(api, accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}"))
    assert len(result) >= 1
    date_re = re.compile(rf"^/{re.escape(CHANNEL)}/\d{{4}}-\d{{2}}-\d{{2}}$")
    assert all(date_re.match(r) for r in result)
    assert f"/{CHANNEL}/{DAY}" in result


async def test_readdir_date_sizes_chat_jsonl(api, accessor):
    await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"))
    assert row.size == len(jsonl_bytes(MESSAGES))


async def test_readdir_members_sized(api, accessor):
    await readdir(accessor, spec(f"/{GUILD_DIR}/members"))
    row = await stat(accessor, spec(f"/{GUILD_DIR}/members/alice__U001.json"))
    assert row.size == len(compact_json_bytes(MEMBERS[0]))


async def test_readdir_unknown_shape_raises_enoent(api, accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec(f"/{GUILD_DIR}/nope"))


async def test_readdir_leaf_raises_enotdir(api, accessor):
    # A file is ENOTDIR, not ENOENT: callers tell "read this" from "nothing
    # here" by the errno.
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"))


async def test_readdir_files_skips_tombstoned_attachments(api, accessor):
    # Tombstoned and access-restricted attachments carry an id but no
    # download URL and no byte size; listing them would surface phantom
    # files that ENOENT on read.
    names = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert names == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]


async def test_files_dir_rides_the_day_fetch(api, accessor):
    # One history fetch answers the day dir AND its files subdir: the day
    # lister seeds the files listing, so entering it costs no second call.
    await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    fetches = len(api.day_fetches)
    names = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert names == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]
    assert len(api.day_fetches) == fetches
