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
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


readdir = _op("readdir")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_readdir_lists_the_folder_its_row_names(accessor):
    folder = FileStat(
        name="docs", type=FileType.DIRECTORY, extra={"file_id": "folder1"}
    )
    files = [
        {
            "id": "file123",
            "name": "readme.txt",
            "mimeType": "text/plain",
            "modifiedTime": "2026-04-01T00:00:00Z",
        }
    ]
    with patch(
        "mirage.core.gdrive.readdir.list_files",
        new_callable=AsyncMock,
        return_value=files,
    ) as lister:
        result = await readdir(accessor, _scope("/docs"), entry=folder)
    assert [row.name for row in result] == ["readme.txt"]
    assert lister.await_args.kwargs["folder_id"] == "folder1"
