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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gdrive.grep import grep
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import materialize
from mirage.types import PathSpec


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def token_manager(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(config, token_manager):
    return GDriveAccessor(config=config, token_manager=token_manager)


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    store._entries["/test/file.txt"] = IndexEntry(
        id="f1",
        name="file.txt",
        resource_type="gdrive/file",
        size=42,
    )
    return store


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(original=path,
                    directory=path.rsplit("/", 1)[0] or "/",
                    prefix=prefix)


@pytest.mark.asyncio
async def test_grep_match(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"hello world\ngoodbye world\nfoo bar\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "hello",
            index=index,
        )
        data = await materialize(result)
        assert b"hello world" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_no_match(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"hello world\ngoodbye world\nfoo bar\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "nonexistent",
            index=index,
        )
        await materialize(result)
        assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_max_count(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"aaa\naaa\naaa\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "aaa",
            m="1",
            index=index,
        )
        data = await materialize(result)
        lines = data.strip().split(b"\n")
        assert len(lines) == 1


@pytest.mark.asyncio
async def test_grep_case_insensitive(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"hello world\ngoodbye world\nfoo bar\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "HELLO",
            i=True,
            index=index,
        )
        data = await materialize(result)
        assert b"hello world" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_invert(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"hello world\ngoodbye world\nfoo bar\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "hello",
            v=True,
            index=index,
        )
        data = await materialize(result)
        assert b"hello" not in data
        assert b"goodbye world" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_count(accessor, index):
    with patch(
            "mirage.commands.builtin.gdrive.grep.gdrive_read",
            new_callable=AsyncMock,
            return_value=b"apple\nbanana\napple pie\n",
    ):
        result, io = await grep(
            accessor,
            [_scope("/test/file.txt")],
            "apple",
            c=True,
            index=index,
        )
        data = await materialize(result)
        assert data.strip() == b"2"


@pytest.mark.asyncio
async def test_grep_stdin(accessor, index):
    stdin_data = b"line one\nline two\nline three\n"
    result, io = await grep(
        accessor,
        [],
        "two",
        stdin=stdin_data,
        index=index,
    )
    data = await materialize(result)
    assert b"line two" in data
    assert io.exit_code == 0
