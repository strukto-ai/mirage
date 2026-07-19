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
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.ops.gdrive import OPS
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


stat = _op("stat")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    return GDriveAccessor(config=config, token_manager=TokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor, index):
    result = await stat(accessor, _scope("/"), index=index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_indexed_file(accessor, index):
    await index.put(
        "/docs/readme.txt",
        IndexEntry(
            id="file123",
            name="readme",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="readme.txt",
            size=7,
        ))
    result = await stat(accessor, _scope("/docs/readme.txt"), index=index)
    assert result.name == "readme.txt"
    assert result.size == 7
    assert result.extra["file_id"] == "file123"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    await index.set_dir("/", [])
    with patch(
            "mirage.core.gdrive.resolve.list_files",
            new_callable=AsyncMock,
            return_value=[],
    ), patch(
            "mirage.core.gdrive.resolve.list_shared_drives",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, _scope("/nonexistent.txt"), index=index)
