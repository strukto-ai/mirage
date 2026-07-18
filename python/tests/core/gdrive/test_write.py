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

from mirage.core.gdrive.write import write_bytes
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_write_creates_in_existing_parent(fake_drive, gdrive_accessor):
    fake_drive.folder("a")
    await write_bytes(gdrive_accessor, spec("/a/new.txt"), b"hello")
    item = fake_drive.find("new.txt")
    assert item is not None
    assert item["content"] == b"hello"


@pytest.mark.asyncio
async def test_write_overwrites_same_id(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("f.txt", content=b"old")
    await write_bytes(gdrive_accessor, spec("/f.txt"), b"new")
    assert fake_drive.items[file_id]["content"] == b"new"
    assert len(fake_drive.items) == 1


@pytest.mark.asyncio
async def test_write_missing_parent_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await write_bytes(gdrive_accessor, spec("/no/f.txt"), b"x")


@pytest.mark.asyncio
async def test_write_to_folder_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await write_bytes(gdrive_accessor, spec("/d"), b"x")
    with pytest.raises(IsADirectoryError):
        await write_bytes(gdrive_accessor, spec("/"), b"x")


@pytest.mark.asyncio
async def test_write_to_native_raises(fake_drive, gdrive_accessor):
    fake_drive.add("Report", mime=DOC_MIME)
    with pytest.raises(PermissionError):
        await write_bytes(gdrive_accessor, spec("/Report.gdoc.json"), b"x")
