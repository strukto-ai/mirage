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
from mirage.ops.gdrive import OPS
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


read = _op("read")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_downloads_plain_file(accessor, index):
    await index.put(
        "/docs/readme.txt",
        IndexEntry(
            id="file123",
            name="readme",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="readme.txt",
        ))
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=b"file content",
    ) as mock:
        result = await read(accessor, _scope("/docs/readme.txt"), index=index)
        mock.assert_called_once_with(accessor.token_manager, "file123")
        assert result == b"file content"


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    await index.set_dir("/", [])
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nonexistent.txt"), index=index)
