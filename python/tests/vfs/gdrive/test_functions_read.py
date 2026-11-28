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


read = _op("read")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.mark.asyncio
async def test_read_downloads_plain_file(google_account):
    made = await google_account.upload(
        "readme.txt", b"file content", await google_account.folder("docs")
    )
    row = FileStat(
        name="readme.txt",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": made, "resource_type": "gdrive/file"},
    )
    await google_account.run.record_requests()
    result = await read(
        google_account.drive_accessor(), _scope("/docs/readme.txt"), entry=row
    )
    assert await google_account.log() == [("media", made)]
    assert result == b"file content"


@pytest.mark.asyncio
async def test_read_not_found(google_account):
    with pytest.raises(FileNotFoundError):
        await read(google_account.drive_accessor(), _scope("/nonexistent.txt"))
