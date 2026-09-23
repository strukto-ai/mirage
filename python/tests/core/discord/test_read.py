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

from mirage.core.discord.read import read, read_range
from mirage.core.discord.render import history_jsonl_bytes
from mirage.types import PathSpec
from tests.core.discord.conftest import DAY, MESSAGES, SEALED_DAY

pytestmark = pytest.mark.asyncio

GUILD_DIR = "My Server__G001"
CHANNEL = f"{GUILD_DIR}/channels/general__C001"
CHAT = f"/{CHANNEL}/{DAY}/chat.jsonl"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path=virtual.lstrip("/"))


async def test_read_jsonl(api, accessor, index):
    # Cold: no prior listing is needed, the read resolves the channel
    # through the index itself.
    result = await read(accessor, spec(CHAT), index)
    assert result == history_jsonl_bytes(MESSAGES)


async def test_read_jsonl_bogus_channel_is_enoent(api, accessor, index):
    # The typed `name__id` is only trusted once the listing proves it, so
    # a fabricated channel id is ENOENT rather than a raw API error.
    with pytest.raises(FileNotFoundError):
        await read(accessor,
                   spec(f"/{GUILD_DIR}/channels/nope__C9/{DAY}/chat.jsonl"),
                   index)


async def test_read_not_found(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/no/such/path"), index)


async def test_read_jsonl_window_is_sliced_locally(api, accessor, index):
    # A rendered branch has no remote range, so the window is taken after.
    whole = history_jsonl_bytes(MESSAGES)
    result = await read_range(accessor, spec(CHAT), index, offset=1, size=4)
    assert result == whole[1:5]


async def test_read_chat_on_a_sealed_day_reproduces_the_api_answer(
        api, accessor, index):
    # The sealed day lists nothing but the file still reads through the
    # channel; the fetch then answers what the API answers.
    import aiohttp
    with pytest.raises(aiohttp.ClientResponseError):
        await read(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/chat.jsonl"),
                   index)


async def test_read_member_json(api, accessor, index):
    data = await read(accessor, spec(f"/{GUILD_DIR}/members/alice__U001.json"),
                      index)
    payload = json.loads(data)
    assert payload["user"]["id"] == "U001"


async def test_read_blob_pushes_the_range_to_the_source(api, accessor, index):
    result = await read_range(accessor,
                              spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt"),
                              index,
                              offset=2,
                              size=3)
    assert result == b"234"
    assert api.downloads == [("https://cdn.example/kept.txt", 2, 3)]


async def test_read_dir_is_enoent_when_unproven(api, accessor, index):
    # A matched shape alone is no existence proof: reading a directory
    # kind answers "No such file" unless the node exists by construction.
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/Nope__G9"), index)


async def test_read_tombstoned_attachment_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor,
                   spec(f"/{CHANNEL}/{DAY}/files/tombstoned__A2.txt"), index)
