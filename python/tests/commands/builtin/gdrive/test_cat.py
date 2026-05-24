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
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gdrive.cat import cat
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
    return store


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(original=path,
                    directory=path.rsplit("/", 1)[0] or "/",
                    prefix=prefix)


async def _mock_stream(*args, **kwargs):
    yield b"chunk1"
    yield b"chunk2"


@pytest.mark.asyncio
async def test_cat_regular_file(accessor, index):
    await index.put(
        "/test/file.txt",
        IndexEntry(
            id="file123",
            name="file.txt",
            resource_type="gdrive/file",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="file.txt",
            size=100,
        ))
    with patch(
            "mirage.core.google.drive.google_get_stream",
            side_effect=_mock_stream,
    ):
        result, io = await cat(
            accessor,
            [_scope("/test/file.txt")],
            index=index,
        )
        data = b""
        async for chunk in result:
            data += chunk
        assert data == b"chunk1chunk2"
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cat_native_google_doc(accessor, index):
    await index.put(
        "/doc.gdoc.json",
        IndexEntry(
            id="doc456",
            name="doc",
            resource_type="gdrive/gdoc",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="doc.gdoc.json",
            size=200,
        ))
    doc_json = {"documentId": "doc456", "body": {"content": []}}
    with patch(
            "mirage.core.gdocs.read.google_get",
            new_callable=AsyncMock,
            return_value=doc_json,
    ):
        result, io = await cat(
            accessor,
            [_scope("/doc.gdoc.json")],
            index=index,
        )
        data = await materialize(result)
        assert b"doc456" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cat_line_numbers(accessor, index):
    await index.put(
        "/test/file.txt",
        IndexEntry(
            id="file123",
            name="file.txt",
            resource_type="gdrive/file",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="file.txt",
            size=100,
        ))

    async def mock_lines(*args, **kwargs):
        yield b"first\nsecond\n"

    with patch(
            "mirage.core.google.drive.google_get_stream",
            side_effect=mock_lines,
    ):
        result, io = await cat(
            accessor,
            [_scope("/test/file.txt")],
            n=True,
            index=index,
        )
        data = await materialize(result)
        lines = data.split(b"\n")
        assert b"1\t" in lines[0]
        assert b"first" in lines[0]
        assert b"2\t" in lines[1]
        assert b"second" in lines[1]


@pytest.mark.asyncio
async def test_cat_stdin(accessor, index):
    stdin_data = b"piped content"
    result, io = await cat(
        accessor,
        [],
        stdin=stdin_data,
        index=index,
    )
    data = await materialize(result)
    assert data == b"piped content"
    assert io.exit_code == 0
