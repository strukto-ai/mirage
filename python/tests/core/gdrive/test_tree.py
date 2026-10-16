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

import aiohttp
import pytest

import mirage.core.gdrive.readdir as readdir_mod
import mirage.core.gdrive.tree as tree_mod
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.tree import (
    PARENTS_PER_QUERY,
    iter_tree,
    list_level,
    tree,
    vfs_name,
)
from mirage.core.google.drive import FOLDER_MIME
from mirage.types import FileType, PathSpec
from tests.fixtures.handed import entry_at

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


async def _no_shared_drives(*args, **kwargs):
    raise PermissionError("no shared drives scope")


async def _drive_down(*args, **kwargs):
    raise aiohttp.ClientConnectionError("drive down")


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/gd/" + vfs_path if vfs_path else "/gd"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


def seed_tree(fake_drive) -> None:
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"aaaa")
    fake_drive.add("big.bin", parent=sub, content=b"x" * 2048)
    fake_drive.add("small.bin", parent=sub, content=b"x" * 16)
    fake_drive.add("Report", mime=DOC_MIME)


@pytest.mark.asyncio
async def test_iter_tree_walks_sorted(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    walked = []
    async for rel, item, is_dir in iter_tree(
        gdrive_accessor, spec("/"), "root", None
    ):
        walked.append((rel, is_dir))
    assert walked == [
        ("Report.gdoc.json", False),
        ("a.txt", False),
        ("sub", True),
        ("sub/big.bin", False),
        ("sub/small.bin", False),
    ]
    sub = fake_drive.find("sub")["id"]
    assert fake_drive.child_queries == [(["root"], None), ([sub], None)]


@pytest.mark.asyncio
async def test_tree_lists_a_level_per_query(fake_drive, gdrive_accessor):
    sub = fake_drive.folder("sub")
    other = fake_drive.folder("other")
    deep = fake_drive.folder("deep", parent=sub)
    fake_drive.add("a.txt", content=b"a")
    fake_drive.add("b.txt", parent=sub, content=b"bb")
    fake_drive.add("c.txt", parent=deep, content=b"ccc")
    found = await tree(gdrive_accessor, scope())
    assert found is not None
    assert sorted(found) == [
        "a.txt",
        "other",
        "sub",
        "sub/b.txt",
        "sub/deep",
        "sub/deep/c.txt",
    ]
    assert found["sub/deep"].type is FileType.DIRECTORY
    assert found["sub/deep/c.txt"].size == 3
    assert (
        found["sub/deep/c.txt"].extra["file_id"]
        == fake_drive.find("c.txt")["id"]
    )
    assert fake_drive.child_queries == [([other, sub], None), ([deep], None)]
    assert len(fake_drive.list_limits) == 1


@pytest.mark.asyncio
async def test_a_wide_level_is_split_into_queries(fake_drive, gdrive_accessor):
    for i in range(PARENTS_PER_QUERY + 5):
        fake_drive.folder(f"d{i:02d}")
    found = await tree(gdrive_accessor, scope())
    assert found is not None
    assert len(found) == PARENTS_PER_QUERY + 5
    assert [len(ids) for ids, _ in fake_drive.child_queries] == [
        PARENTS_PER_QUERY,
        5,
    ]


@pytest.mark.asyncio
async def test_a_subfolder_tree_starts_at_its_listing(
    fake_drive, gdrive_accessor
):
    sub = fake_drive.folder("sub")
    deep = fake_drive.folder("deep", parent=sub)
    fake_drive.add("a.txt", content=b"a")
    fake_drive.add("c.txt", parent=deep, content=b"c")
    under = scope("sub")
    found = await tree(
        gdrive_accessor,
        under,
        await entry_at(readdir, gdrive_accessor, under),
    )
    assert found is not None
    assert sorted(found) == ["deep", "deep/c.txt"]


@pytest.mark.asyncio
async def test_a_missing_folder_raises_what_its_listing_raises(
    fake_drive, gdrive_accessor
):
    with pytest.raises(FileNotFoundError):
        await tree(gdrive_accessor, scope("gone"), None)


@pytest.mark.asyncio
async def test_a_short_root_listing_is_left_to_the_walk(
    fake_drive, gdrive_accessor, monkeypatch
):
    fake_drive.folder("sub")
    monkeypatch.setattr(readdir_mod, "list_shared_drives", _no_shared_drives)
    assert await tree(gdrive_accessor, scope()) is None
    assert fake_drive.child_queries == []


@pytest.mark.asyncio
async def test_of_two_names_alike_the_last_row_stands(
    fake_drive, gdrive_accessor
):
    first = fake_drive.folder("twin")
    second = fake_drive.folder("twin")
    fake_drive.add("one.txt", parent=first)
    fake_drive.add("two.txt", parent=second)
    found = await tree(gdrive_accessor, scope())
    assert found is not None
    assert sorted(found) == ["twin", "twin/two.txt"]
    assert found["twin"].extra["file_id"] == second


@pytest.mark.asyncio
async def test_a_level_is_asked_per_shared_drive(fake_drive, gdrive_accessor):
    mine = fake_drive.folder("mine")
    left = fake_drive.add(
        "left", parent="drive-1", mime=FOLDER_MIME, drive_id="drive-1"
    )
    right = fake_drive.add(
        "right", parent="drive-1", mime=FOLDER_MIME, drive_id="drive-1"
    )
    lone = fake_drive.add("x.txt", parent=left, drive_id="drive-1")
    fake_drive.add("y.txt", parent=right, drive_id="drive-1")
    children = await list_level(
        gdrive_accessor,
        [(mine, None), (left, "drive-1"), (right, "drive-1")],
    )
    assert fake_drive.child_queries == [
        ([mine], None),
        ([left, right], "drive-1"),
    ]
    assert children[mine] == []
    assert [item["id"] for item in children[left]] == [lone]
    assert [item["name"] for item in children[right]] == ["y.txt"]


def test_vfs_name_renders_native_suffix():
    assert (
        vfs_name({"name": "Report", "mimeType": DOC_MIME})
        == "Report.gdoc.json"
    )
    assert vfs_name({"name": "a.txt", "mimeType": "text/plain"}) == "a.txt"


@pytest.mark.asyncio
async def test_a_level_that_fails_is_left_to_the_walk(
    fake_drive, gdrive_accessor, monkeypatch
):
    fake_drive.folder("sub")
    monkeypatch.setattr(tree_mod, "list_children", _drive_down)
    assert await tree(gdrive_accessor, scope()) is None
