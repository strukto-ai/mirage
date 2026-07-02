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

from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.rg import rg
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _concrete_paths(n: int = 7):
    return [
        PathSpec(
            resource_path=mount_key(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl",
                "/slack"),
            virtual=(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl"),
            directory=(
                f"/slack/channels/general__C1/2026-01-{d:02d}/chat.jsonl"),
        ) for d in range(1, n + 1)
    ]


@pytest.mark.asyncio
async def test_grep_with_many_concrete_paths_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_payload = (b'{"messages":{"matches":[{"channel":{"name":"general",'
                    b'"id":"C1"},"ts":"1700000000.0","text":"hello there"}]}}')
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(return_value=fake_payload),
    ) as fake_search:
        out, io = await grep(accessor, _concrete_paths(7), "hello", i=True)
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello there" in out


@pytest.mark.asyncio
async def test_rg_with_many_concrete_paths_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_payload = (b'{"messages":{"matches":[{"channel":{"name":"general",'
                    b'"id":"C1"},"ts":"1700000000.0","text":"hello rg"}]}}')
    with patch(
            "mirage.commands.builtin.slack.rg.search_messages",
            new=AsyncMock(return_value=fake_payload),
    ) as fake_search:
        out, io = await rg(accessor, _concrete_paths(7), "hello", i=True)
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello rg" in out


@pytest.mark.asyncio
async def test_grep_falls_back_when_native_search_raises():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(resource_path=mount_key("/slack/channels/general__C1/*.jsonl",
                                         "/slack"),
                 virtual="/slack/channels/general__C1/*.jsonl",
                 directory="/slack/channels/general__C1/",
                 pattern="*.jsonl"),
    ]
    resolved = [
        PathSpec(resource_path=mount_key(
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
    ):
        out, io = await grep(accessor, paths, "hello", i=True)
    assert io.exit_code in (0, 1)


@pytest.mark.asyncio
async def test_grep_native_empty_does_not_trigger_fallback():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    empty_payload = b'{"messages":{"matches":[]}}'
    with patch(
            "mirage.commands.builtin.slack.grep.search_messages",
            new=AsyncMock(return_value=empty_payload),
    ) as fake_search, patch(
            "mirage.commands.builtin.slack.grep.slack_read",
            new=AsyncMock(return_value=b""),
    ) as fake_read:
        out, io = await grep(accessor, _concrete_paths(7), "missing")
    assert fake_search.await_count == 1
    assert fake_read.await_count == 0
    assert io.exit_code == 1
    assert out == b""
