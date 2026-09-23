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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.rg import rg
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.io.types import IOResult, materialize
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _concrete_paths(n: int = 7):
    paths = []
    for d in range(1, n + 1):
        original = (f"/discord/myguild__g_123/channels/general__ch_456/"
                    f"2026-01-{d:02d}/chat.jsonl")
        paths.append(
            PathSpec(
                vfs_path=mount_key(original, "/discord"),
                virtual=original,
                directory=original,
            ))
    return paths


def _channel_path(name: str = "general__ch_456") -> PathSpec:
    original = f"/discord/myguild__g_123/channels/{name}"
    return PathSpec(vfs_path=mount_key(original, "/discord"),
                    virtual=original,
                    directory=original)


@pytest.mark.asyncio
async def test_discord_grep_channel_dir_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_msgs = [{
        "content": "hello world",
        "channel_id": "ch_456",
        "author": {
            "username": "alice"
        },
        "timestamp": "2026-01-15T12:34:56.000000+00:00",
        "id": "1"
    }]
    fake_channels = [{"id": "ch_456", "name": "general"}]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=fake_msgs),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.list_channels",
            new=AsyncMock(return_value=fake_channels),
    ):
        out, io = await grep(accessor, [_channel_path()], ['hello'],
                             CommandOpts(flags={
                                 'w': True,
                                 'r': True
                             }))
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello" in out
    assert out.endswith(b"\n")
    assert (b"/discord/myguild__g_123/channels/general__ch_456/"
            b"2026-01-15/chat.jsonl:") in out


@pytest.mark.asyncio
async def test_discord_grep_with_many_concrete_paths_defers_to_scan():
    # These used to fold into one channel-wide search (`coalesce_scopes`).
    # `search_guild` takes a channel but no date, so seven named days were
    # answered with every day the channel ever had. The scan reads the seven.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.discord.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, _concrete_paths(7), ['hello'],
                   CommandOpts(flags={'w': True}))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_discord_grep_second_channel_operand_defers_to_scan():
    # Two channels never coalesced at all, so the first operand won and the
    # second was dropped in silence.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.discord.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(
            accessor,
            [_channel_path(), _channel_path("random__ch_789")], ['hello'],
            CommandOpts(flags={
                'w': True,
                'r': True
            }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_discord_grep_shaping_flag_defers_to_scan():
    # -n reshapes each output line, which a verbatim search answer cannot do.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.discord.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, [_channel_path()], ['hello'],
                   CommandOpts(flags={
                       'w': True,
                       'r': True,
                       'n': True
                   }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_discord_grep_resolves_ids_without_index():
    """The ids ride in the ``name__id`` dirnames, so a cold cache must not
    degrade the push-down or emit a spurious fallback warning."""
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    path = "/discord/myguild__g_123/channels/general__ch_456"
    paths = [
        PathSpec(vfs_path=mount_key(path, "/discord"),
                 virtual=path,
                 directory=path)
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.list_channels",
            new=AsyncMock(return_value=[]),
    ):
        out, io = await grep(accessor, paths, ['hello'],
                             CommandOpts(flags={'w': True}))
    assert fake_search.await_count == 1
    assert fake_search.await_args.args[1] == "g_123"
    assert fake_search.await_args.kwargs["channel_id"] == "ch_456"
    assert io.stderr in (None, b"")


@pytest.mark.asyncio
async def test_discord_grep_bare_names_skip_native_search():
    """Without ``__id`` in the dirnames there is nothing to search with —
    fall through to the scan instead of guessing."""
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    path = "/discord/myguild/channels/general"
    paths = [
        PathSpec(vfs_path=mount_key(path, "/discord"),
                 virtual=path,
                 directory=path)
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ):
        with pytest.raises(UsageError):
            await grep(accessor, paths, ['hello'],
                       CommandOpts(flags={'w': True}))
    fake_search.assert_not_awaited()


@pytest.mark.asyncio
async def test_discord_grep_falls_back_when_native_raises():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(vfs_path=mount_key(
            "/discord/myguild__g_123/channels/general__ch_456/*.jsonl",
            "/discord"),
                 virtual="/discord/myguild__g_123/channels/general__ch_456"
                 "/*.jsonl",
                 directory="/discord/myguild__g_123/channels/general__ch_456/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(side_effect=RuntimeError("rate limited")),
    ), patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.grep._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.FILE,
                                                content=ContentType.TEXT)),
    ):
        out, io = await grep(accessor, paths, ['hello'],
                             CommandOpts(flags={'w': True}))
    assert fake_resolve.await_count == 1
    assert io.exit_code in (0, 1)


@pytest.mark.asyncio
async def test_discord_grep_native_empty_does_not_trigger_fallback():
    """search_guild returning [] is a legit no-match — don't double-scan."""
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.list_channels",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ) as fake_read:
        out, io = await grep(accessor, [_channel_path()], ['missing'],
                             CommandOpts(flags={
                                 'w': True,
                                 'r': True
                             }))
    assert fake_search.await_count == 1
    assert fake_read.await_count == 0
    assert io.exit_code == 1
    assert out == b""


@pytest.mark.asyncio
async def test_discord_grep_multi_pattern_skips_native_search():
    """grep -e a -e b must bypass the native search push-down.

    The push-down passes a single newline-joined pattern to the native
    search, which treats it as one literal and matches nothing. Multiple
    -e patterns must fall through to the generic grep instead.
    """
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(vfs_path=mount_key(
            "/discord/myguild__g_123/channels/general__ch_456/*.jsonl",
            "/discord"),
                 virtual="/discord/myguild__g_123/channels/general__ch_456"
                 "/*.jsonl",
                 directory="/discord/myguild__g_123/channels/general__ch_456/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.grep._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.FILE,
                                                content=ContentType.TEXT)),
    ):
        _, io = await grep(accessor, paths, [],
                           CommandOpts(flags={
                               'e': ['ada', 'ben'],
                               'w': True
                           }))
    assert fake_search.await_count == 0
    assert fake_resolve.await_count == 1


@pytest.mark.asyncio
async def test_discord_rg_channel_dir_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_msgs = [{
        "content": "hello rg",
        "channel_id": "ch_456",
        "author": {
            "username": "bob"
        },
        "timestamp": "2026-01-15T08:00:00.000000+00:00",
        "id": "2"
    }]
    fake_channels = [{"id": "ch_456", "name": "general"}]
    with patch(
            "mirage.commands.builtin.discord.rg.search_guild",
            new=AsyncMock(return_value=fake_msgs),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.rg.list_channels",
            new=AsyncMock(return_value=fake_channels),
    ):
        out, io = await rg(accessor, [_channel_path()], ['hello'],
                           CommandOpts(flags={'w': True}))
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello" in out
    assert out.endswith(b"\n")
    assert (b"/discord/myguild__g_123/channels/general__ch_456/"
            b"2026-01-15/chat.jsonl:") in out


@pytest.mark.asyncio
async def test_discord_rg_multi_pattern_skips_native_search():
    """rg -e a -e b must bypass the native search push-down.

    Like grep, the push-down passes a single newline-joined pattern to the
    native search, which matches nothing. Multiple -e patterns must fall
    through to the generic rg instead.
    """
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(vfs_path=mount_key(
            "/discord/myguild__g_123/channels/general__ch_456/*.jsonl",
            "/discord"),
                 virtual="/discord/myguild__g_123/channels/general__ch_456"
                 "/*.jsonl",
                 directory="/discord/myguild__g_123/channels/general__ch_456/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.rg.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.rg.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.rg.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.rg._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.FILE,
                                                content=ContentType.TEXT)),
    ):
        _, io = await rg(accessor, paths, [],
                         CommandOpts(flags={
                             'e': ['ada', 'ben'],
                             'w': True
                         }))
    assert fake_search.await_count == 0
    assert fake_resolve.await_count == 1


@pytest.mark.asyncio
async def test_discord_grep_without_word_flag_skips_native_search():
    # Discord search matches whole words while grep matches substrings, and
    # the native path returns search results verbatim as the grep output, so
    # a bare literal would under-report. Only -w may take it.
    accessor = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ):
        with pytest.raises(UsageError):
            await grep(accessor, _concrete_paths(7), ['hello'], CommandOpts())
    fake_search.assert_not_awaited()


@pytest.mark.asyncio
async def test_discord_grep_file_blob_skips_native_search():
    """An attachment operand must scan its bytes; widening it to a
    channel-wide message search would return hits that say nothing about
    the requested file."""
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    path = ("/discord/myguild__g_123/channels/general__ch_456/2026-01-01/"
            "files/img__A1.png")
    paths = [
        PathSpec(vfs_path=mount_key(path, "/discord"),
                 virtual=path,
                 directory=path)
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ), patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b"quarter,amount\n"),
    ), patch(
            "mirage.commands.builtin.discord.grep._stat",
            new=AsyncMock(return_value=FileStat(name="img__A1.png",
                                                type=FileType.FILE,
                                                content=ContentType.TEXT)),
    ):
        out, io = await grep(accessor, paths, ['quarter'],
                             CommandOpts(flags={'w': True}))
    fake_search.assert_not_awaited()
    assert io.exit_code == 0
    assert b"quarter,amount" in await materialize(out)
