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

from collections.abc import Callable
from dataclasses import replace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.io import IO as BACKEND_IO
from mirage.commands.builtin.discord.io import IO as DISCORD_IO
from mirage.commands.builtin.discord.rg import rg
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.config import CommandOpts
from mirage.core.time_range import TimeRange
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _io(
    monkeypatch: pytest.MonkeyPatch, **slots: Callable[..., Any]
) -> CommandIO:
    """Replace backend slots while retaining the checked adapter contract."""
    resolve = slots.pop("resolve_glob", None)
    if resolve is not None:
        monkeypatch.setattr(CommandIO, "resolve_glob", staticmethod(resolve))
    return replace(DISCORD_IO, **slots)


def _channel_path(name: str = "general__ch_456") -> PathSpec:
    original = f"/discord/myguild__g_123/channels/{name}"
    return PathSpec(
        vfs_path=mount_key(original, "/discord"),
        virtual=original,
        directory=original,
    )


@pytest.mark.asyncio
async def test_discord_grep_resolves_ids_without_index():
    """The ids ride in the ``name__id`` dirnames, so a cold cache must not
    degrade the push-down or emit a spurious fallback warning."""
    accessor = AsyncMock()
    accessor.time_range = TimeRange()
    accessor.config = AsyncMock()
    path = "/discord/myguild__g_123/channels/general__ch_456"
    paths = [
        PathSpec(
            vfs_path=mount_key(path, "/discord"), virtual=path, directory=path
        )
    ]
    fake_search = AsyncMock(return_value=[])
    with patch.dict(
        grep.__globals__,
        {
            "search_guild": fake_search,
            "list_channels": AsyncMock(return_value=[]),
        },
    ):
        out, io = await grep(
            BACKEND_IO,
            accessor,
            paths,
            ["hello"],
            CommandOpts(flags={"w": True}),
        )
    assert fake_search.await_count == 1
    assert fake_search.await_args.args[1] == "g_123"
    assert fake_search.await_args.kwargs["channel_id"] == "ch_456"
    assert io.stderr in (None, b"")


@pytest.mark.asyncio
async def test_discord_rg_channel_dir_uses_native_search():
    accessor = AsyncMock()
    accessor.time_range = TimeRange()
    accessor.config = AsyncMock()
    fake_msgs = [
        {
            "content": "hello rg",
            "channel_id": "ch_456",
            "author": {"username": "bob"},
            "timestamp": "2026-01-15T08:00:00.000000+00:00",
            "id": "2",
        }
    ]
    fake_channels = [{"id": "ch_456", "name": "general"}]
    fake_search = AsyncMock(return_value=fake_msgs)
    with patch.dict(
        rg.__globals__,
        {
            "search_guild": fake_search,
            "list_channels": AsyncMock(return_value=fake_channels),
        },
    ):
        out, io = await rg(
            BACKEND_IO,
            accessor,
            [_channel_path()],
            ["hello"],
            CommandOpts(flags={"word_regexp": True}),
        )
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello" in out
    assert out.endswith(b"\n")
    assert (
        b"/discord/myguild__g_123/channels/general__ch_456/"
        b"2026-01-15/chat.jsonl:"
    ) in out


@pytest.mark.asyncio
async def test_discord_grep_on_a_time_scoped_mount_skips_native_search(
    monkeypatch,
):
    """Discord search cannot honor the mount's time bounds, so a scoped
    mount answers from the per-file scan of the in-scope days."""
    accessor = AsyncMock()
    accessor.time_range = TimeRange.from_strings(None, "2026-02-01T00:00:00Z")
    accessor.config = AsyncMock()
    paths = [_channel_path()]
    fake_search = AsyncMock(return_value=[])
    fake_scan = AsyncMock(return_value=(b"", IOResult(exit_code=1)))
    ops = _io(monkeypatch, resolve_glob=AsyncMock(return_value=paths))
    with patch.dict(
        grep.__globals__,
        {
            "search_guild": fake_search,
            "grep_generic": fake_scan,
        },
    ):
        await grep(
            ops,
            accessor,
            paths,
            ["hello"],
            CommandOpts(flags={"w": True, "r": True}),
        )
    fake_search.assert_not_awaited()
    fake_scan.assert_awaited_once()
