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

from mirage.core.discord.entry import snowflake_to_iso
from mirage.core.discord.render import history_jsonl_bytes
from mirage.core.discord.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from tests.core.discord.conftest import CHANNELS, DAY, MESSAGES, SEALED_DAY

pytestmark = pytest.mark.asyncio

GUILD_DIR = "My Server__G001"
CHANNEL = f"{GUILD_DIR}/channels/general__C001"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path=virtual.lstrip("/"))


async def test_stat_root(api, accessor, index):
    row = await stat(accessor, spec("/"), index)
    assert row.type is FileType.DIRECTORY


async def test_stat_guild(api, accessor, index):
    row = await stat(accessor, spec(f"/{GUILD_DIR}"), index)
    assert row.type is FileType.DIRECTORY
    assert row.name == GUILD_DIR
    assert row.extra["guild_id"] == "G001"


async def test_stat_bogus_guild_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/Nope__G9"), index)


async def test_stat_containers(api, accessor, index):
    for name in ("channels", "members"):
        row = await stat(accessor, spec(f"/{GUILD_DIR}/{name}"), index)
        assert row.type is FileType.DIRECTORY
        assert row.name == name


async def test_stat_container_under_bogus_guild_is_enoent(
        api, accessor, index):
    # The containers exist per guild, so a guild the listing does not
    # prove takes its children with it.
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/Nope__G9/channels"), index)


async def test_stat_channel(api, accessor, index):
    row = await stat(accessor, spec(f"/{CHANNEL}"), index)
    assert row.type is FileType.DIRECTORY
    assert row.extra["channel_id"] == "C001"
    assert row.modified == snowflake_to_iso(CHANNELS[0]["last_message_id"])


async def test_stat_member(api, accessor, index):
    row = await stat(accessor, spec(f"/{GUILD_DIR}/members/alice__U001.json"),
                     index)
    assert row.content is ContentType.JSON
    assert row.extra["user_id"] == "U001"
    assert row.size is not None and row.size > 0


async def test_stat_day_dir(api, accessor, index):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}"), index)
    assert row.type is FileType.DIRECTORY
    assert row.name == DAY


async def test_stat_day_outside_the_window_is_a_directory(
        api, accessor, index):
    # The channel listing synthesizes a bounded window of recent days, but
    # the history API answers a range query for any date.
    row = await stat(accessor, spec(f"/{CHANNEL}/1999-01-01"), index)
    assert row.type is FileType.DIRECTORY
    assert row.name == "1999-01-01"


async def test_stat_day_under_bogus_channel_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec(f"/{GUILD_DIR}/channels/nope__C9/{DAY}"),
                   index)


async def test_stat_chat_jsonl(api, accessor, index):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"), index)
    assert row.content is ContentType.TEXT
    assert row.size == len(history_jsonl_bytes(MESSAGES))


async def test_stat_chat_jsonl_sealed_day_has_unknown_size(
        api, accessor, index):
    # A day whose history could not be listed (403/404/429) seals an empty
    # date dir; the file still stats, with the size left unknown.
    row = await stat(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/chat.jsonl"),
                     index)
    assert row.content is ContentType.TEXT
    assert row.size is None


async def test_stat_chat_jsonl_under_bogus_channel_is_enoent(
        api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor,
                   spec(f"/{GUILD_DIR}/channels/nope__C9/{DAY}/chat.jsonl"),
                   index)


async def test_stat_files_dir(api, accessor, index):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/files"), index)
    assert row.type is FileType.DIRECTORY


async def test_stat_files_under_a_sealed_day_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/files"), index)


async def test_stat_file_blob(api, accessor, index):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt"),
                     index)
    assert row.size == 5
    assert row.extra["attachment_id"] == "A1"
    assert row.extra["content_type"] == "text/plain"


async def test_stat_unknown_shape_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec(f"/{GUILD_DIR}/nope"), index)
