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

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


stat = _op("stat")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    return GDriveAccessor(config=config, token_manager=TokenManager(config))


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor):
    result = await stat(accessor, _scope("/"))
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_answers_the_listed_row(accessor):
    row = FileStat(
        name="readme.txt",
        type=FileType.FILE,
        size=7,
        extra={"file_id": "file123", "resource_type": "gdrive/file"},
    )
    result = await stat(accessor, _scope("/docs/readme.txt"), entry=row)
    assert result.name == "readme.txt"
    assert result.size == 7
    assert result.extra["file_id"] == "file123"


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _scope("/nonexistent.txt"))
