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

from mirage.cache.context import push_cache_manager
from mirage.core.gdrive.rename import rename
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


class _FakeManager:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.unlinks: list[str] = []
        self.subtrees: list[str] = []

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.virtual)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path.virtual)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path.virtual)

    async def invalidate_after_move(
        self, path: PathSpec, folder: bool
    ) -> None:
        if folder:
            await self.invalidate_subtree(path)
        else:
            await self.invalidate_after_unlink(path)


async def _managed(accessor, src: str, dst: str) -> _FakeManager:
    manager = _FakeManager()
    prev = push_cache_manager(manager)
    try:
        await rename(accessor, spec(src), spec(dst))
    finally:
        push_cache_manager(prev)
    return manager


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
    # The conflict probe is bounded, not a full listing: `list_files`
    # follows every page token, so asking it with a small `page_size`
    # made one request per child to answer a yes/no.
    assert 1 in fake_drive.list_limits


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
    await rename(
        gdrive_accessor, spec("/Report.gdoc.json"), spec("/Plan.gdoc.json")
    )
    assert fake_drive.items[doc_id]["name"] == "Plan"


@pytest.mark.asyncio
async def test_renaming_a_file_drops_no_subtree(fake_drive, gdrive_accessor):
    fake_drive.add("old.txt", content=b"x")
    manager = await _managed(gdrive_accessor, "/old.txt", "/new.txt")
    assert manager.unlinks == ["/new.txt", "/old.txt"]
    assert manager.subtrees == []


@pytest.mark.asyncio
async def test_renaming_a_folder_drops_both_subtrees(
    fake_drive, gdrive_accessor
):
    folder = fake_drive.folder("a")
    fake_drive.add("f.txt", parent=folder, content=b"x")
    manager = await _managed(gdrive_accessor, "/a", "/b")
    assert manager.subtrees == ["/b", "/a"]
    assert manager.unlinks == []


@pytest.mark.asyncio
async def test_a_file_replacing_an_empty_folder_drops_its_subtree(
    fake_drive, gdrive_accessor
):
    # The rename deleted the folder at dst, so whatever is still cached
    # under that name (children removed outside mirage, say) goes too.
    fake_drive.add("src.txt", content=b"x")
    fake_drive.folder("d")
    manager = await _managed(gdrive_accessor, "/src.txt", "/d")
    assert manager.subtrees == ["/d"]
    assert manager.unlinks == ["/src.txt"]
    assert manager.writes == []


@pytest.mark.asyncio
async def test_a_file_replacing_a_file_drops_no_subtree(
    fake_drive, gdrive_accessor
):
    fake_drive.add("src.txt", content=b"x")
    fake_drive.add("dst.txt", content=b"y")
    manager = await _managed(gdrive_accessor, "/src.txt", "/dst.txt")
    assert manager.unlinks == ["/dst.txt", "/src.txt"]
    assert manager.subtrees == []
