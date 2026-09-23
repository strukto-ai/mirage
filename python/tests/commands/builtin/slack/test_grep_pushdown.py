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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _concrete_paths(n: int = 7):
    return [
        PathSpec(
            vfs_path=mount_key(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl",
                "/slack"),
            virtual=(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl"),
            directory=(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl"),
        ) for d in range(1, n + 1)
    ]


@pytest.mark.asyncio
async def test_grep_with_many_concrete_paths_defers_to_scan():
    # These used to fold into one channel-wide search (`coalesce_scopes`).
    # That search carries `in:#general` and no date, so seven named days were
    # answered with every day the channel ever had. The scan reads the seven.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.slack.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(
            accessor, _concrete_paths(7), ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'i': True
                        }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_with_many_concrete_paths_defers_to_scan():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.slack.rg.search_messages",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.rg.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.slack.rg.generic_rg",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await rg(
            accessor, _concrete_paths(7), ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'i': True
                        }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_second_channel_operand_defers_to_scan():
    # Two channels never coalesced at all, so the first operand won and the
    # second was dropped in silence.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    channels = [
        PathSpec(vfs_path=mount_key(f"/slack/channels/{name}", "/slack"),
                 virtual=f"/slack/channels/{name}",
                 directory=f"/slack/channels/{name}")
        for name in ("general__C1", "random__C2")
    ]
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.slack.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(
            accessor, channels, ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'r': True
                        }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_shaping_flag_defers_to_scan():
    # -n reshapes each output line, which a verbatim search answer cannot do.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    channel = [
        PathSpec(vfs_path=mount_key("/slack/channels/general__C1", "/slack"),
                 virtual="/slack/channels/general__C1",
                 directory="/slack/channels/general__C1")
    ]
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.slack.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(
            accessor, channel, ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'r': True,
                            'n': True
                        }))
    fake_search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_falls_back_when_native_search_raises():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(vfs_path=mount_key("/slack/channels/general__C1/*.jsonl",
                                    "/slack"),
                 virtual="/slack/channels/general__C1/*.jsonl",
                 directory="/slack/channels/general__C1/",
                 pattern="*.jsonl"),
    ]
    resolved = [
        PathSpec(vfs_path=mount_key(
            "/slack/channels/general__C1/2026-04-10/chat.jsonl", "/slack"),
                 virtual="/slack/channels/general__C1/2026-04-10/chat.jsonl",
                 directory="/slack/channels/general__C1/2026-04-10/"),
    ]
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(
                side_effect=RuntimeError("missing search:read scope")),
    ), patch(
            "mirage.commands.builtin.slack.grep.resolve_glob",
            new=AsyncMock(return_value=resolved),
    ), patch(
            "mirage.commands.builtin.slack.grep.slack_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.slack.grep._stat",
            new=AsyncMock(return_value=FileStat(name="chat.jsonl",
                                                type=FileType.FILE,
                                                content=ContentType.TEXT,
                                                size=0)),
    ):
        out, io = await grep(
            accessor, paths, ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'i': True
                        }))
    assert io.exit_code in (0, 1)


@pytest.mark.asyncio
async def test_grep_native_empty_does_not_trigger_fallback():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    channel = [
        PathSpec(vfs_path=mount_key("/slack/channels/general__C1", "/slack"),
                 virtual="/slack/channels/general__C1",
                 directory="/slack/channels/general__C1")
    ]
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(return_value=b'{"messages":{"matches":[]}}'),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.grep.search_files",
            new=AsyncMock(return_value=b'{"files":{"matches":[]}}'),
    ), patch(
            "mirage.commands.builtin.slack.grep.slack_read",
            new=AsyncMock(return_value=b""),
    ) as fake_read:
        out, io = await grep(
            accessor, channel, ['missing'],
            CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    assert fake_search.await_count == 1
    assert fake_read.await_count == 0
    assert io.exit_code == 1
    assert out == b""


@pytest.mark.asyncio
async def test_grep_without_word_flag_skips_native_search():
    # Slack search matches whole words while grep matches substrings, and the
    # native path returns search results verbatim as the grep output, so a
    # bare literal would under-report. Only -w may take it.
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with (
            patch(
                "mirage.commands.builtin.slack.grep.search_messages",
                new=AsyncMock(return_value=b"{}"),
            ) as fake_search,
            # stat now hydrates chat.jsonl through the parent readdir; an
            # empty channel listing keeps the scan ending in ENOENT.
            patch(
                "mirage.core.slack.readdir.list_channels",
                new=AsyncMock(return_value=[]),
            ),
    ):
        # Falling through to the per-file scan is the point: the mock
        # accessor cannot serve any file, so every operand erroring proves
        # the native path was skipped rather than silently returning
        # search results.
        out, io = await grep(
            accessor, _concrete_paths(7), ['hello'],
            CommandOpts(index=RAMIndexCacheStore(), flags={'i': True}))
    fake_search.assert_not_awaited()
    assert out == b""
    assert io.exit_code == 2
    assert b"No such file" in io.stderr
