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

import errno

import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.rmdir import rmdir
from mirage.types import PathSpec
from tests.fixtures.handed import call


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rmdir_removes_dir(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    await call(rmdir, readdir, gdrive_accessor, spec("/d"))
    assert fake_drive.find("d") is None


@pytest.mark.asyncio
async def test_rmdir_missing_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await call(rmdir, readdir, gdrive_accessor, spec("/missing"))


@pytest.mark.asyncio
async def test_rmdir_file_raises(fake_drive, gdrive_accessor):
    fake_drive.add("f.txt", content=b"x")
    with pytest.raises(NotADirectoryError):
        await call(rmdir, readdir, gdrive_accessor, spec("/f.txt"))


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_file(
    fake_drive, gdrive_accessor
):
    folder = fake_drive.folder("d")
    fake_drive.add("a.txt", parent=folder, content=b"a")
    with pytest.raises(OSError) as excinfo:
        await call(rmdir, readdir, gdrive_accessor, spec("/d"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert fake_drive.find("d") is not None
    assert fake_drive.find("a.txt") is not None


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_subfolder(
    fake_drive, gdrive_accessor
):
    folder = fake_drive.folder("d")
    fake_drive.folder("sub", parent=folder)
    with pytest.raises(OSError) as excinfo:
        await call(rmdir, readdir, gdrive_accessor, spec("/d"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert fake_drive.find("d") is not None
    assert fake_drive.find("sub") is not None
