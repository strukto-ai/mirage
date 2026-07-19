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

from mirage.core.gdrive.rename import rename
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rename_in_place(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("old.txt", content=b"x")
    await rename(gdrive_accessor, spec("/old.txt"), spec("/new.txt"))
    assert fake_drive.items[file_id]["name"] == "new.txt"
    assert fake_drive.items[file_id]["parents"] == ["root"]


@pytest.mark.asyncio
async def test_rename_moves_between_folders(fake_drive, gdrive_accessor):
    src_dir = fake_drive.folder("a")
    dst_dir = fake_drive.folder("b")
    file_id = fake_drive.add("f.txt", parent=src_dir, content=b"x")
    await rename(gdrive_accessor, spec("/a/f.txt"), spec("/b/g.txt"))
    item = fake_drive.items[file_id]
    assert item["name"] == "g.txt"
    assert item["parents"] == [dst_dir]


@pytest.mark.asyncio
async def test_rename_replaces_existing_file(fake_drive, gdrive_accessor):
    src_id = fake_drive.add("src.txt", content=b"new")
    fake_drive.add("dst.txt", content=b"old")
    await rename(gdrive_accessor, spec("/src.txt"), spec("/dst.txt"))
    assert fake_drive.find("src.txt") is None
    assert fake_drive.items[src_id]["name"] == "dst.txt"
    assert len(fake_drive.items) == 1


@pytest.mark.asyncio
async def test_rename_over_nonempty_dir_raises(fake_drive, gdrive_accessor):
    fake_drive.add("src.txt", content=b"x")
    folder = fake_drive.folder("d")
    fake_drive.add("f.txt", parent=folder, content=b"y")
    with pytest.raises(OSError) as exc_info:
        await rename(gdrive_accessor, spec("/src.txt"), spec("/d"))
    assert exc_info.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_rename_replaces_empty_dir(fake_drive, gdrive_accessor):
    src_id = fake_drive.add("src.txt", content=b"x")
    fake_drive.folder("d")
    await rename(gdrive_accessor, spec("/src.txt"), spec("/d"))
    assert fake_drive.items[src_id]["name"] == "d"
    assert len(fake_drive.items) == 1


@pytest.mark.asyncio
async def test_rename_missing_src_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await rename(gdrive_accessor, spec("/missing.txt"), spec("/x.txt"))


@pytest.mark.asyncio
async def test_rename_native_strips_suffix(fake_drive, gdrive_accessor):
    doc_id = fake_drive.add("Report", mime=DOC_MIME)
    await rename(gdrive_accessor, spec("/Report.gdoc.json"),
                 spec("/Plan.gdoc.json"))
    assert fake_drive.items[doc_id]["name"] == "Plan"
