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

from mirage.core.gdrive.truncate import truncate
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_truncate_shrinks(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("f.txt", content=b"abcdef")
    await truncate(gdrive_accessor, spec("/f.txt"), 3)
    assert fake_drive.items[file_id]["content"] == b"abc"


@pytest.mark.asyncio
async def test_truncate_pads(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("f.txt", content=b"ab")
    await truncate(gdrive_accessor, spec("/f.txt"), 4)
    assert fake_drive.items[file_id]["content"] == b"ab\x00\x00"


@pytest.mark.asyncio
async def test_truncate_creates_missing(fake_drive, gdrive_accessor):
    await truncate(gdrive_accessor, spec("/new.txt"), 2)
    item = fake_drive.find("new.txt")
    assert item is not None
    assert item["content"] == b"\x00\x00"


@pytest.mark.asyncio
async def test_truncate_folder_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await truncate(gdrive_accessor, spec("/d"), 0)
