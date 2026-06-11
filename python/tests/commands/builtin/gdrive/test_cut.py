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

from unittest.mock import patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gdrive.cut import cut
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
    return RAMIndexCacheStore()


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(original=path,
                    directory=path.rsplit("/", 1)[0] or "/",
                    prefix=prefix)


async def _mock_stream(*args, **kwargs):
    yield b"a,b,c\n1,2,3\n"


@pytest.mark.asyncio
async def test_cut_fields(accessor, index):
    await index.put(
        "/test/file.csv",
        IndexEntry(
            id="file123",
            name="file.csv",
            resource_type="gdrive/file",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="file.csv",
            size=100,
        ))
    with patch(
            "mirage.core.google.drive.google_get_stream",
            side_effect=_mock_stream,
    ):
        result, io = await cut(
            accessor,
            [_scope("/test/file.csv")],
            d=",",
            f="2",
            index=index,
        )
        data = await materialize(result)
        assert data == b"b\n2\n"
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cut_chars(accessor, index):
    await index.put(
        "/test/file.txt",
        IndexEntry(
            id="file456",
            name="file.txt",
            resource_type="gdrive/file",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="file.txt",
            size=100,
        ))

    async def mock_lines(*args, **kwargs):
        yield b"hello\nworld\n"

    with patch(
            "mirage.core.google.drive.google_get_stream",
            side_effect=mock_lines,
    ):
        result, io = await cut(
            accessor,
            [_scope("/test/file.txt")],
            c="1-3",
            index=index,
        )
        data = await materialize(result)
        assert data == b"hel\nwor\n"
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cut_stdin(accessor, index):
    result, io = await cut(
        accessor,
        [],
        stdin=b"x:y:z\n",
        d=":",
        f="1,3",
        index=index,
    )
    data = await materialize(result)
    assert data == b"x:z\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cut_missing_operand(accessor, index):
    with pytest.raises(ValueError, match="cut: missing operand"):
        result, _io = await cut(accessor, [], f="1", index=index)
        await materialize(result)
