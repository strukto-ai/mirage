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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.slack.rg import rg
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return SlackAccessor(config=SlackConfig(token="xoxb", search_token="xoxp"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_rg_messages_only_when_chat_jsonl(accessor, index):
    msgs_payload = b'{"messages":{"matches":[]}}'
    with (
            patch("mirage.commands.builtin.slack.rg.search_messages",
                  new_callable=AsyncMock,
                  return_value=msgs_payload) as mock_msgs,
            patch("mirage.commands.builtin.slack.rg.search_files",
                  new_callable=AsyncMock) as mock_files,
    ):
        await rg(
            accessor,
            [
                PathSpec(
                    original="/channels/general__C001/2026-04-10/chat.jsonl",
                    directory="/channels/general__C001/2026-04-10/chat.jsonl",
                    prefix="",
                )
            ],
            "foo",
            index=index,
        )
    assert mock_msgs.await_count == 1
    assert mock_files.await_count == 0


@pytest.mark.asyncio
async def test_rg_files_only_when_files_dir(accessor, index):
    files_payload = b'{"files":{"matches":[]}}'
    with (
            patch("mirage.commands.builtin.slack.rg.search_messages",
                  new_callable=AsyncMock) as mock_msgs,
            patch("mirage.commands.builtin.slack.rg.search_files",
                  new_callable=AsyncMock,
                  return_value=files_payload) as mock_files,
    ):
        await rg(
            accessor,
            [
                PathSpec(
                    original="/channels/general__C001/2026-04-10/files",
                    directory="/channels/general__C001/2026-04-10/files",
                    prefix="",
                )
            ],
            "foo",
            index=index,
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 1


@pytest.mark.asyncio
async def test_rg_both_when_channel_or_day_root(accessor, index):
    msgs_payload = b'{"messages":{"matches":[]}}'
    files_payload = b'{"files":{"matches":[]}}'
    with (
            patch("mirage.commands.builtin.slack.rg.search_messages",
                  new_callable=AsyncMock,
                  return_value=msgs_payload) as mock_msgs,
            patch("mirage.commands.builtin.slack.rg.search_files",
                  new_callable=AsyncMock,
                  return_value=files_payload) as mock_files,
    ):
        await rg(
            accessor,
            [
                PathSpec(
                    original="/channels/general__C001/2026-04-10",
                    directory="/channels/general__C001/2026-04-10",
                    prefix="",
                )
            ],
            "foo",
            index=index,
        )
    assert mock_msgs.await_count == 1
    assert mock_files.await_count == 1


@pytest.mark.asyncio
async def test_grep_messages_only_when_chat_jsonl(accessor, index):
    msgs_payload = b'{"messages":{"matches":[]}}'
    with (
            patch("mirage.commands.builtin.slack.grep.search_messages",
                  new_callable=AsyncMock,
                  return_value=msgs_payload) as mock_msgs,
            patch("mirage.commands.builtin.slack.grep.search_files",
                  new_callable=AsyncMock) as mock_files,
    ):
        from mirage.commands.builtin.slack.grep import grep
        await grep(
            accessor,
            [
                PathSpec(
                    original="/channels/general__C001/2026-04-10/chat.jsonl",
                    directory="/channels/general__C001/2026-04-10/chat.jsonl",
                    prefix="",
                )
            ],
            "foo",
            index=index,
        )
    assert mock_msgs.await_count == 1
    assert mock_files.await_count == 0


@pytest.mark.asyncio
async def test_grep_files_only_when_files_dir(accessor, index):
    files_payload = b'{"files":{"matches":[]}}'
    with (
            patch("mirage.commands.builtin.slack.grep.search_messages",
                  new_callable=AsyncMock) as mock_msgs,
            patch("mirage.commands.builtin.slack.grep.search_files",
                  new_callable=AsyncMock,
                  return_value=files_payload) as mock_files,
    ):
        from mirage.commands.builtin.slack.grep import grep
        await grep(
            accessor,
            [
                PathSpec(
                    original="/channels/general__C001/2026-04-10/files",
                    directory="/channels/general__C001/2026-04-10/files",
                    prefix="",
                )
            ],
            "foo",
            index=index,
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 1
