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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.discord.head import head
from mirage.commands.config import CommandOpts
from mirage.core.discord.history import date_to_snowflake
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

DAY = "2026-06-01"
CHAT = (f"/discord/myguild__G1/channels/general__C1/{DAY}/chat.jsonl")


def _path(path: str) -> PathSpec:
    return PathSpec(vfs_path=mount_key(path, "/discord"),
                    virtual=path,
                    directory=path)


def _msg(mid: str, content: str) -> dict:
    return {"id": mid, "content": content}


def _in_day(offset: int) -> str:
    return str(int(date_to_snowflake(DAY)) + offset)


def _next_day() -> str:
    return str(int(date_to_snowflake(DAY, end=True)) + 1)


@pytest.mark.asyncio
async def test_smart_head_fetches_only_first_n_messages():
    fake_get = AsyncMock(
        return_value=[_msg(_in_day(2), "b"),
                      _msg(_in_day(1), "a")])
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get):
        out, io = await head(AsyncMock(), [_path(CHAT)], [],
                             CommandOpts(flags={"lines": "2"}))
    assert io.exit_code == 0
    assert fake_get.await_count == 1
    assert fake_get.await_args.args[1] == "/channels/C1/messages"
    assert fake_get.await_args.kwargs["params"]["limit"] == 2
    lines = (await materialize(out)).decode().splitlines()
    assert [json.loads(ln)["content"] for ln in lines] == ["a", "b"]


@pytest.mark.asyncio
async def test_smart_head_drops_messages_past_end_of_day():
    # With `after`, a short day spills into the next one; head must not
    # print lines the day's chat.jsonl does not contain.
    fake_get = AsyncMock(
        return_value=[_msg(_in_day(1), "in-day"),
                      _msg(_next_day(), "spill")])
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get):
        out, io = await head(AsyncMock(), [_path(CHAT)], [],
                             CommandOpts(flags={"lines": "5"}))
    assert io.exit_code == 0
    lines = (await materialize(out)).decode().splitlines()
    assert [json.loads(ln)["content"] for ln in lines] == ["in-day"]


@pytest.mark.asyncio
async def test_head_bytes_flag_uses_generic_path():
    fake_get = AsyncMock()
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get), patch(
                   "mirage.commands.builtin.discord.head.resolve_or_empty",
                   new=AsyncMock(return_value=[]),
               ), patch(
                   "mirage.commands.builtin.discord.head.head_generic",
                   new=AsyncMock(return_value=(b"", None)),
               ) as fake_generic:
        await head(AsyncMock(), [_path(CHAT)], [],
                   CommandOpts(flags={"bytes": "10"}))
    fake_get.assert_not_awaited()
    assert fake_generic.await_count == 1


@pytest.mark.asyncio
async def test_head_non_messages_path_uses_generic_path():
    fake_get = AsyncMock()
    member = "/discord/myguild__G1/members/alice__U1.json"
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get), patch(
                   "mirage.commands.builtin.discord.head.resolve_or_empty",
                   new=AsyncMock(return_value=[]),
               ), patch(
                   "mirage.commands.builtin.discord.head.head_generic",
                   new=AsyncMock(return_value=(b"", None)),
               ) as fake_generic:
        await head(AsyncMock(), [_path(member)], [], CommandOpts())
    fake_get.assert_not_awaited()
    assert fake_generic.await_count == 1


@pytest.mark.asyncio
async def test_head_verbose_uses_generic_path():
    # -v prints the ==> path <== header, which only the generic path
    # renders.
    fake_get = AsyncMock()
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get), patch(
                   "mirage.commands.builtin.discord.head.resolve_or_empty",
                   new=AsyncMock(return_value=[]),
               ), patch(
                   "mirage.commands.builtin.discord.head.head_generic",
                   new=AsyncMock(return_value=(b"", None)),
               ) as fake_generic:
        await head(AsyncMock(), [_path(CHAT)], [],
                   CommandOpts(flags={
                       "lines": "2",
                       "verbose": True
                   }))
    fake_get.assert_not_awaited()
    assert fake_generic.await_count == 1


@pytest.mark.asyncio
async def test_head_count_beyond_one_page_uses_generic_path():
    # Discord caps a message page at 100; larger counts (and zero or
    # negative all-but-last-N forms) keep the generic path.
    fake_get = AsyncMock()
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get), patch(
                   "mirage.commands.builtin.discord.head.resolve_or_empty",
                   new=AsyncMock(return_value=[]),
               ), patch(
                   "mirage.commands.builtin.discord.head.head_generic",
                   new=AsyncMock(return_value=(b"", None)),
               ) as fake_generic:
        await head(AsyncMock(), [_path(CHAT)], [],
                   CommandOpts(flags={"lines": "150"}))
        await head(AsyncMock(), [_path(CHAT)], [],
                   CommandOpts(flags={"lines": "-5"}))
    fake_get.assert_not_awaited()
    assert fake_generic.await_count == 2


@pytest.mark.asyncio
async def test_smart_head_empty_day_outputs_nothing():
    # A day whose fetch is entirely next-day spill must render b"" like
    # the day renderer does, not a lone blank line.
    fake_get = AsyncMock(return_value=[_msg(_next_day(), "spill")])
    with patch("mirage.commands.builtin.discord.head.discord_get",
               new=fake_get):
        out, io = await head(AsyncMock(), [_path(CHAT)], [],
                             CommandOpts(flags={"lines": "3"}))
    assert io.exit_code == 0
    assert (await materialize(out)) == b""
