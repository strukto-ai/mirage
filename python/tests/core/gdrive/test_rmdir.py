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

from mirage.core.gdrive.rmdir import rmdir
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rmdir_removes_dir(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    await rmdir(gdrive_accessor, spec("/d"))
    assert fake_drive.find("d") is None


@pytest.mark.asyncio
async def test_rmdir_missing_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await rmdir(gdrive_accessor, spec("/missing"))


@pytest.mark.asyncio
async def test_rmdir_file_raises(fake_drive, gdrive_accessor):
    fake_drive.add("f.txt", content=b"x")
    with pytest.raises(NotADirectoryError):
        await rmdir(gdrive_accessor, spec("/f.txt"))
