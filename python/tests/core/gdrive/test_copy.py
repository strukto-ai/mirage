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

from mirage.core.gdrive.copy import copy
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_copy_file(fake_drive, gdrive_accessor):
    fake_drive.add("src.txt", content=b"data")
    await copy(gdrive_accessor, spec("/src.txt"), spec("/dst.txt"))
    dst = fake_drive.find("dst.txt")
    assert dst is not None
    assert dst["content"] == b"data"
    assert fake_drive.find("src.txt") is not None


@pytest.mark.asyncio
async def test_copy_overwrites_existing_file(fake_drive, gdrive_accessor):
    fake_drive.add("src.txt", content=b"new")
    fake_drive.add("dst.txt", content=b"old")
    await copy(gdrive_accessor, spec("/src.txt"), spec("/dst.txt"))
    dst = fake_drive.find("dst.txt")
    assert dst is not None
    assert dst["content"] == b"new"
    assert len(fake_drive.items) == 2


@pytest.mark.asyncio
async def test_copy_file_onto_dir_raises(fake_drive, gdrive_accessor):
    fake_drive.add("src.txt", content=b"x")
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await copy(gdrive_accessor, spec("/src.txt"), spec("/d"))


@pytest.mark.asyncio
async def test_copy_tree_creates_missing_dir(fake_drive, gdrive_accessor):
    src = fake_drive.folder("src")
    sub = fake_drive.folder("sub", parent=src)
    fake_drive.add("f.txt", parent=sub, content=b"deep")
    fake_drive.add("top.txt", parent=src, content=b"top")
    await copy(gdrive_accessor, spec("/src"), spec("/dst"))
    dst = fake_drive.find("dst")
    assert dst is not None
    for name in ("sub", "f.txt", "top.txt"):
        copies = [i for i in fake_drive.items.values() if i["name"] == name]
        assert len(copies) == 2
    deep = [i for i in fake_drive.items.values() if i["name"] == "f.txt"]
    assert {i["content"] for i in deep} == {b"deep"}


@pytest.mark.asyncio
async def test_copy_tree_merges_existing_dir(fake_drive, gdrive_accessor):
    src = fake_drive.folder("src")
    fake_drive.add("f.txt", parent=src, content=b"x")
    dst = fake_drive.folder("dst")
    fake_drive.add("keep.txt", parent=dst, content=b"k")
    await copy(gdrive_accessor, spec("/src"), spec("/dst"))
    dst_children = [
        i for i in fake_drive.items.values() if dst in i["parents"]
    ]
    assert {i["name"] for i in dst_children} == {"keep.txt", "f.txt"}


@pytest.mark.asyncio
async def test_copy_dir_onto_file_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("src")
    fake_drive.add("f.txt", content=b"x")
    with pytest.raises(NotADirectoryError):
        await copy(gdrive_accessor, spec("/src"), spec("/f.txt"))


@pytest.mark.asyncio
async def test_copy_missing_src_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await copy(gdrive_accessor, spec("/missing.txt"), spec("/dst.txt"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("folder", "dst_kind", "fails", "raised", "expected"),
    [
        (
            False,
            None,
            False,
            None,
            [("copy_file", "dst.txt"), ("write", "/dst.txt")],
        ),
        (
            False,
            "file",
            True,
            RuntimeError,
            [
                ("delete_file",),
                ("copy_file", "dst.txt"),
                ("write", "/dst.txt"),
            ],
        ),
        (
            True,
            None,
            False,
            None,
            [("copy_file", "f.txt"), ("subtree", "/dst")],
        ),
        (
            True,
            "folder",
            True,
            RuntimeError,
            [("copy_file", "f.txt"), ("subtree", "/dst")],
        ),
        (
            True,
            "file",
            False,
            NotADirectoryError,
            [("subtree", "/dst")],
        ),
    ],
    ids=["file-ok", "file-fails", "folder-ok", "folder-fails", "refused"],
)
async def test_a_copy_evicts_after_it_ends(
    fake_drive, gdrive_accessor, folder, dst_kind, fails, raised, expected
):
    if folder:
        src = fake_drive.folder("src")
        fake_drive.add("f.txt", parent=src, content=b"new")
        src_path, dst_path = "/src", "/dst"
    else:
        fake_drive.add("src.txt", content=b"new")
        src_path, dst_path = "/src.txt", "/dst.txt"
    dst_name = dst_path.lstrip("/")
    if dst_kind == "file":
        fake_drive.add(dst_name, content=b"old")
    elif dst_kind == "folder":
        fake_drive.folder(dst_name)
    events: list[tuple[str, ...]] = []

    async def copy_file(token_manager, file_id, name, parent_id):
        events.append(("copy_file", name))
        if fails:
            raise RuntimeError("copy failed")
        return await fake_drive.copy_file(
            token_manager, file_id, name, parent_id
        )

    async def delete_file(token_manager, file_id):
        events.append(("delete_file",))
        await fake_drive.delete_file(token_manager, file_id)

    async def wrote(path):
        events.append(("write", path.virtual))

    async def dropped(path):
        events.append(("subtree", path.virtual))

    with (
        patch("mirage.core.gdrive.copy.copy_file", new=copy_file),
        patch("mirage.core.gdrive.copy.delete_file", new=delete_file),
        patch(
            "mirage.core.gdrive.copy.invalidate_after_write",
            new=AsyncMock(side_effect=wrote),
        ),
        patch(
            "mirage.core.gdrive.copy.invalidate_subtree",
            new=AsyncMock(side_effect=dropped),
        ),
    ):
        if raised is None:
            await copy(gdrive_accessor, spec(src_path), spec(dst_path))
        else:
            with pytest.raises(raised):
                await copy(gdrive_accessor, spec(src_path), spec(dst_path))
    assert events == expected
