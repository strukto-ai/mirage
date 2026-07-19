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

from mirage.core.box.copy import copy
from mirage.core.box.mkdir import mkdir
from mirage.core.box.rename import rename
from mirage.core.box.rmdir import rm_r, rmdir
from mirage.core.box.unlink import unlink
from mirage.core.box.write import write_bytes
from mirage.types import PathSpec

_TREE = {
    "0": [
        {
            "id": "100",
            "name": "data",
            "type": "folder"
        },
    ],
    "100": [
        {
            "id": "200",
            "name": "a.txt",
            "type": "file",
            "size": 5
        },
        {
            "id": "300",
            "name": "sub",
            "type": "folder"
        },
    ],
    "300": [],
}


def _spec(virtual: str) -> PathSpec:
    return PathSpec(resource_path=virtual.strip("/"),
                    virtual=virtual,
                    directory=virtual)


async def _fake_list(_tm, folder_id, limit=1000):
    return _TREE.get(folder_id, [])


@pytest.fixture
def root_accessor(accessor):
    # Mount root is the account root "0".
    return accessor


@pytest.mark.asyncio
async def test_write_new_file_uploads_under_parent(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.write.upload_new_file",
               new_callable=AsyncMock) as up, \
         patch("mirage.core.box.write.invalidate_after_write",
               new_callable=AsyncMock):
        await write_bytes(root_accessor, _spec("/data/new.txt"), b"hello")
    up.assert_awaited_once_with(root_accessor.token_manager, "100", "new.txt",
                                b"hello")


@pytest.mark.asyncio
async def test_write_existing_file_uploads_version(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.write.upload_file_version",
               new_callable=AsyncMock) as ver, \
         patch("mirage.core.box.write.invalidate_after_write",
               new_callable=AsyncMock):
        await write_bytes(root_accessor, _spec("/data/a.txt"), b"OVER")
    ver.assert_awaited_once_with(root_accessor.token_manager, "200", "a.txt",
                                 b"OVER")


@pytest.mark.asyncio
async def test_write_missing_parent_raises(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.write.invalidate_after_write",
               new_callable=AsyncMock):
        with pytest.raises(FileNotFoundError):
            await write_bytes(root_accessor, _spec("/data/ghost/x.txt"), b"x")


@pytest.mark.asyncio
async def test_mkdir_creates_under_parent(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.mkdir.create_folder",
               new_callable=AsyncMock, return_value={"id": "400"}) as cf, \
         patch("mirage.core.box.mkdir.invalidate_after_write",
               new_callable=AsyncMock):
        await mkdir(root_accessor, _spec("/data/newdir"))
    cf.assert_awaited_once_with(root_accessor.token_manager, "100", "newdir")


@pytest.mark.asyncio
async def test_mkdir_parents_creates_each_missing_level(root_accessor):
    created: list = []

    async def fake_create(_tm, parent_id, name):
        new_id = f"new-{name}"
        created.append((parent_id, name))
        _TREE.setdefault(parent_id, []).append({
            "id": new_id,
            "name": name,
            "type": "folder"
        })
        _TREE[new_id] = []
        return {"id": new_id}

    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.mkdir.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.mkdir.create_folder", new=fake_create), \
         patch("mirage.core.box.mkdir.invalidate_after_write",
               new_callable=AsyncMock) as inv:
        await mkdir(root_accessor, _spec("/data/p/q"), parents=True)
    assert ("100", "p") in created
    # invalidate fires once per path level (data/p/q) so a cached ancestor
    # listing refreshes and sees the new folders.
    assert inv.await_count == 3
    _TREE.pop("new-p", None)
    _TREE.pop("new-q", None)
    _TREE["100"] = [e for e in _TREE["100"] if e["name"] != "p"]


@pytest.mark.asyncio
async def test_unlink_deletes_file(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.unlink.delete_file",
               new_callable=AsyncMock) as df, \
         patch("mirage.core.box.unlink.invalidate_after_unlink",
               new_callable=AsyncMock):
        await unlink(root_accessor, _spec("/data/a.txt"))
    df.assert_awaited_once_with(root_accessor.token_manager, "200")


@pytest.mark.asyncio
async def test_unlink_on_folder_raises_isdir(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list):
        with pytest.raises(IsADirectoryError):
            await unlink(root_accessor, _spec("/data/sub"))


@pytest.mark.asyncio
async def test_rmdir_deletes_folder_non_recursive(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.rmdir.delete_folder",
               new_callable=AsyncMock) as df, \
         patch("mirage.core.box.rmdir.invalidate_after_unlink",
               new_callable=AsyncMock):
        await rmdir(root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(root_accessor.token_manager,
                                "300",
                                recursive=False)


@pytest.mark.asyncio
async def test_rm_r_recursive_on_folder(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.rmdir.delete_folder",
               new_callable=AsyncMock) as df, \
         patch("mirage.core.box.rmdir.invalidate_after_unlink",
               new_callable=AsyncMock):
        await rm_r(root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(root_accessor.token_manager,
                                "300",
                                recursive=True)


@pytest.mark.asyncio
async def test_rename_moves_file(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.rename.update_file",
               new_callable=AsyncMock) as uf, \
         patch("mirage.core.box.rename.invalidate_after_write",
               new_callable=AsyncMock), \
         patch("mirage.core.box.rename.invalidate_after_unlink",
               new_callable=AsyncMock):
        await rename(root_accessor, _spec("/data/a.txt"), _spec("/data/b.txt"))
    uf.assert_awaited_once_with(root_accessor.token_manager,
                                "200",
                                name="b.txt",
                                parent_id="100")


@pytest.mark.asyncio
async def test_copy_file(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.copy.copy_file",
               new_callable=AsyncMock) as cf, \
         patch("mirage.core.box.copy.invalidate_after_write",
               new_callable=AsyncMock):
        await copy(root_accessor, _spec("/data/a.txt"), _spec("/data/c.txt"))
    cf.assert_awaited_once_with(root_accessor.token_manager,
                                "200",
                                "100",
                                name="c.txt")
