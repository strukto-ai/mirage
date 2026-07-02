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
from mirage.commands.builtin.gdrive.sed import sed
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


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
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.mark.asyncio
async def test_sed_simple_substitution(accessor, index):
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
            "mirage.core.google.drive.google_get_bytes",
            new_callable=AsyncMock,
            return_value=b"hello world\nhello again\n",
    ):
        result, io = await sed(
            accessor,
            [_scope("/test/file.txt")],
            "s/hello/bye/g",
            index=index,
        )
        data = await materialize(result)
        assert data == b"bye world\nbye again\n"
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_sed_print_program(accessor, index):
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
            "mirage.core.google.drive.google_get_bytes",
            new_callable=AsyncMock,
            return_value=b"one\ntwo\nthree\n",
    ):
        result, io = await sed(
            accessor,
            [_scope("/test/file.txt")],
            "2p",
            n=True,
            index=index,
        )
        data = await materialize(result)
        assert data == b"two\n"
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_sed_stdin(accessor, index):
    result, io = await sed(
        accessor,
        [],
        "s/a/b/g",
        stdin=b"banana\n",
        index=index,
    )
    data = await materialize(result)
    assert data == b"bbnbnb\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_sed_in_place_rejected(accessor, index):
    with pytest.raises(PermissionError, match="read-only Google Drive"):
        await sed(
            accessor,
            [_scope("/test/file.txt")],
            "s/a/b/",
            i=True,
            index=index,
        )


@pytest.mark.asyncio
async def test_sed_missing_expression(accessor, index):
    with pytest.raises(ValueError, match="sed: usage"):
        await sed(accessor, [], index=index)
