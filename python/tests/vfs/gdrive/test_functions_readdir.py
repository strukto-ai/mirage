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


@pytest.mark.asyncio
async def test_readdir_lists_the_folder_its_row_names(google_account):
    made = await google_account.folder("docs")
    await google_account.upload("readme.txt", b"r", made)
    folder = FileStat(
        name="docs", type=FileType.DIRECTORY, extra={"file_id": made}
    )
    await google_account.run.record_requests()
    result = await readdir(
        google_account.drive_accessor(), _scope("/docs"), entry=folder
    )
    assert [row.name for row in result] == ["readme.txt"]
    assert await google_account.log() == [("list", made)]
