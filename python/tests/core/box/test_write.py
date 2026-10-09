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
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest

from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import copy
from mirage.core.box.mkdir import mkdir
from mirage.core.box.rename import rename
from mirage.core.box.rmdir import rm_r, rmdir
from mirage.core.box.unlink import unlink
from mirage.core.box.write import write
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec

_TREE = {
    "0": [
        {"id": "100", "name": "data", "type": "folder"},
    ],
    "100": [
        {"id": "200", "name": "a.txt", "type": "file", "size": 5},
        {"id": "300", "name": "sub", "type": "folder"},
        {"id": "400", "name": "dst", "type": "folder"},
    ],
    "300": [],
    "400": [],
}


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


async def _fake_list(_tm, folder_id, limit=1000):
    return _TREE.get(folder_id, [])


@pytest.fixture
def root_accessor(accessor):
    # Mount root is the account root "0".
    return accessor


@pytest.mark.asyncio
async def test_write_new_file_uploads_under_parent(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.write.upload_new_file", new_callable=AsyncMock
        ) as up,
        patch(
            "mirage.core.box.write.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        await write(root_accessor, _spec("/data/new.txt"), b"hello")
    up.assert_awaited_once_with(
        root_accessor.token_manager, "100", "new.txt", b"hello"
    )


@pytest.mark.asyncio
async def test_write_existing_file_uploads_version(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.write.upload_file_version", new_callable=AsyncMock
        ) as ver,
        patch(
            "mirage.core.box.write.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        await write(root_accessor, _spec("/data/a.txt"), b"OVER")
    ver.assert_awaited_once_with(
        root_accessor.token_manager, "200", "a.txt", b"OVER", None
    )


@pytest.mark.asyncio
async def test_write_missing_parent_raises(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.write.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await write(root_accessor, _spec("/data/ghost/x.txt"), b"x")


@pytest.mark.asyncio
async def test_mkdir_creates_under_parent(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder",
            new_callable=AsyncMock,
            return_value={"id": "400"},
        ) as cf,
        patch(
            "mirage.core.box.mkdir.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        await mkdir(root_accessor, _spec("/data/newdir"))
    cf.assert_awaited_once_with(root_accessor.token_manager, "100", "newdir")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("virtual", "error"),
    [
        ("/data/a.txt/x", NotADirectoryError),
        ("/data/a.txt/x/y", NotADirectoryError),
        ("/data/missing/x", FileNotFoundError),
    ],
)
async def test_mkdir_refuses_a_parent_that_is_not_a_folder(
    root_accessor, virtual, error
):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder", new_callable=AsyncMock
        ) as cf,
    ):
        with pytest.raises(error):
            await mkdir(root_accessor, _spec(virtual))
    cf.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("virtual", "error"),
    [
        ("/data/a.txt/x/y", NotADirectoryError),
        ("/data/a.txt", FileExistsError),
    ],
)
async def test_mkdir_parents_names_the_file_it_stops_at(
    root_accessor, virtual, error
):
    with (
        patch("mirage.core.box.mkdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder", new_callable=AsyncMock
        ) as cf,
    ):
        with pytest.raises(error, match="'/data/a.txt'$"):
            await mkdir(root_accessor, _spec(virtual), parents=True)
    cf.assert_not_awaited()


@pytest.mark.asyncio
async def test_mkdir_of_a_taken_name_is_eexist(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("Box POST /folders -> 409", 409),
        ),
    ):
        with pytest.raises(FileExistsError):
            await mkdir(root_accessor, _spec("/data/a.txt"))


@pytest.mark.asyncio
async def test_mkdir_parents_creates_each_missing_level(root_accessor):
    created: list = []

    async def fake_create(_tm, parent_id, name):
        new_id = f"new-{name}"
        created.append((parent_id, name))
        _TREE.setdefault(parent_id, []).append(
            {"id": new_id, "name": name, "type": "folder"}
        )
        _TREE[new_id] = []
        return {"id": new_id}

    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch("mirage.core.box.mkdir.list_folder_items", new=_fake_list),
        patch("mirage.core.box.mkdir.create_folder", new=fake_create),
        patch(
            "mirage.core.box.mkdir.invalidate_after_write",
            new_callable=AsyncMock,
        ) as inv,
    ):
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
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.unlink.delete_file", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.unlink.invalidate_after_unlink",
            new_callable=AsyncMock,
        ),
    ):
        await unlink(root_accessor, _spec("/data/a.txt"))
    df.assert_awaited_once_with(root_accessor.token_manager, "200", None)


@pytest.mark.asyncio
async def test_unlink_on_folder_raises_isdir(root_accessor):
    with patch("mirage.core.box.resolve.list_folder_items", new=_fake_list):
        with pytest.raises(IsADirectoryError):
            await unlink(root_accessor, _spec("/data/sub"))


@pytest.mark.asyncio
async def test_rmdir_deletes_folder_non_recursive(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rmdir.invalidate_after_unlink",
            new_callable=AsyncMock,
        ),
    ):
        await rmdir(root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(
        root_accessor.token_manager, "300", recursive=False
    )


@pytest.mark.asyncio
async def test_rm_r_recursive_on_folder(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rmdir.invalidate_subtree", new_callable=AsyncMock
        ),
    ):
        await rm_r(root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(
        root_accessor.token_manager, "300", recursive=True
    )


@pytest.mark.asyncio
async def test_rename_moves_file(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rename.update_file", new_callable=AsyncMock
        ) as uf,
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        await rename(root_accessor, _spec("/data/a.txt"), _spec("/data/b.txt"))
    uf.assert_awaited_once_with(
        root_accessor.token_manager, "200", name="b.txt", parent_id="100"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("src", "dst", "update", "folder"),
    [
        ("/data/a.txt", "/data/b.txt", "update_file", False),
        ("/data/sub", "/data/moved", "update_folder", True),
    ],
    ids=["file", "folder"],
)
async def test_only_a_renamed_file_drops_no_subtree(
    root_accessor, src, dst, update, folder
):
    src, dst = _spec(src), _spec(dst)
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(f"mirage.core.box.rename.{update}", new_callable=AsyncMock),
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ) as moved,
    ):
        await rename(root_accessor, src, dst)
    assert [c.args for c in moved.await_args_list] == [
        (dst, folder),
        (src, folder),
    ]


@pytest.mark.asyncio
async def test_rename_replaces_empty_folder_destination(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        await rename(root_accessor, _spec("/data/sub"), _spec("/data/dst"))
    df.assert_awaited_once_with(
        root_accessor.token_manager, "400", recursive=False
    )
    uo.assert_awaited_once_with(
        root_accessor.token_manager, "300", name="dst", parent_id="100"
    )


@pytest.mark.asyncio
async def test_rename_refuses_nonempty_folder_destination(root_accessor):
    # Box decides the emptiness, not us: recursive=false 409s on a folder
    # with children, and that is mv's "Directory not empty".
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("conflict", 409),
        ),
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(OSError) as caught:
            await rename(root_accessor, _spec("/data/sub"), _spec("/data/dst"))
    assert caught.value.errno == errno.ENOTEMPTY
    assert uo.await_count == 0


@pytest.mark.asyncio
async def test_rename_unmapped_folder_error_propagates(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("boom", 500),
        ),
        patch("mirage.core.box.rename.update_folder", new_callable=AsyncMock),
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(BoxApiError):
            await rename(root_accessor, _spec("/data/sub"), _spec("/data/dst"))


@pytest.mark.asyncio
async def test_rename_file_onto_folder_raises_isdir(root_accessor):
    # rename(2) answers EISDIR for a file onto a directory whether or not
    # that directory has children, so the type check outranks emptiness and
    # the folder is never deleted to find out.
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_file", new_callable=AsyncMock
        ) as uf,
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(IsADirectoryError):
            await rename(
                root_accessor, _spec("/data/a.txt"), _spec("/data/sub")
            )
    assert df.await_count == 0
    assert uf.await_count == 0


@pytest.mark.asyncio
async def test_rename_folder_onto_file_raises_notdir(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
        patch(
            "mirage.core.box.rename.invalidate_after_move",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(NotADirectoryError):
            await rename(
                root_accessor, _spec("/data/sub"), _spec("/data/a.txt")
            )
    assert df.await_count == 0
    assert uo.await_count == 0


@pytest.mark.asyncio
async def test_copy_file_onto_folder_raises_isdir(root_accessor):
    # cp refuses a type mismatch rather than replacing: this branch used to
    # recursively delete the destination folder.
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch("mirage.core.box.copy.copy_file", new_callable=AsyncMock) as cf,
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.copy.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(IsADirectoryError):
            await copy(root_accessor, _spec("/data/a.txt"), _spec("/data/sub"))
    assert cf.await_count == 0
    assert df.await_count == 0


@pytest.mark.asyncio
async def test_copy_folder_onto_file_raises_notdir(root_accessor):
    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
        patch("mirage.core.box.copy.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.copy.copy_folder", new_callable=AsyncMock
        ) as cd,
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.copy.invalidate_after_write",
            new_callable=AsyncMock,
        ),
    ):
        with pytest.raises(NotADirectoryError):
            await copy(root_accessor, _spec("/data/sub"), _spec("/data/a.txt"))
    assert cd.await_count == 0
    assert df.await_count == 0


@pytest.mark.asyncio
async def test_copy_file(root_accessor):
    scope = RecordingScope()
    try:
        with (
            patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.copy.copy_file", new_callable=AsyncMock
            ) as cf,
            patch(
                "mirage.core.box.copy.invalidate_after_write",
                new_callable=AsyncMock,
            ),
        ):
            await copy(
                root_accessor, _spec("/data/a.txt"), _spec("/data/c.txt")
            )
    finally:
        scope.close()
    cf.assert_awaited_once_with(
        root_accessor.token_manager, "200", "100", name="c.txt"
    )
    assert [(r.op, r.path) for r in scope.records] == [("copy", "/data/c.txt")]


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(root_accessor):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        with (
            patch(
                "mirage.core.box.write.resolve_item",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "mirage.core.box.write.resolve_parent_id",
                new_callable=AsyncMock,
                return_value="100",
            ),
            patch(
                "mirage.core.box.write.upload_new_file", new_callable=AsyncMock
            ),
            patch(
                "mirage.core.box.write.invalidate_after_write",
                new_callable=AsyncMock,
            ),
        ):
            await write(root_accessor, spec, b"hello")
    finally:
        scope.close()
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


_COPY_TREE = {
    "0": [{"id": "100", "name": "data", "type": "folder"}],
    "100": [
        {"id": "200", "name": "a.txt", "type": "file", "size": 5},
        {"id": "210", "name": "b.txt", "type": "file", "size": 5},
        {"id": "300", "name": "sub", "type": "folder"},
        {"id": "400", "name": "dst", "type": "folder"},
    ],
    "300": [{"id": "310", "name": "x.txt", "type": "file", "size": 3}],
    "400": [{"id": "410", "name": "x.txt", "type": "file", "size": 3}],
}


async def _copy_list(_tm, folder_id, limit=1000):
    return _COPY_TREE.get(folder_id, [])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("src", "dst", "fails", "raised", "expected"),
    [
        (
            "/data/a.txt",
            "/data/c.txt",
            False,
            None,
            [
                ("copy_file", "c.txt"),
                ("write", "/data/c.txt"),
            ],
        ),
        (
            "/data/a.txt",
            "/data/b.txt",
            True,
            RuntimeError,
            [
                ("delete_file", "210"),
                ("copy_file", "b.txt"),
                ("write", "/data/b.txt"),
            ],
        ),
        (
            "/data/sub",
            "/data/new",
            False,
            None,
            [
                ("copy_folder", "new"),
                ("subtree", "/data/new"),
            ],
        ),
        (
            "/data/sub",
            "/data/dst",
            True,
            RuntimeError,
            [
                ("delete_file", "410"),
                ("copy_file", "x.txt"),
                ("subtree", "/data/dst"),
            ],
        ),
        (
            "/data/sub",
            "/data/a.txt",
            False,
            NotADirectoryError,
            [("subtree", "/data/a.txt")],
        ),
    ],
    ids=["file-ok", "file-fails", "folder-ok", "folder-fails", "refused"],
)
async def test_a_copy_evicts_after_it_ends(
    root_accessor, src, dst, fails, raised, expected
):
    events: list[tuple[str, str]] = []

    async def fake_copy_file(_tm, _file_id, _parent_id, name=None):
        events.append(("copy_file", name))
        if fails:
            raise RuntimeError("copy failed")
        return {}

    async def fake_copy_folder(_tm, _folder_id, _parent_id, name=None):
        events.append(("copy_folder", name))
        return {}

    async def fake_delete_file(_tm, file_id, _etag=None):
        events.append(("delete_file", file_id))

    async def wrote(path):
        events.append(("write", path.virtual))

    async def dropped(path):
        events.append(("subtree", path.virtual))

    with (
        patch("mirage.core.box.resolve.list_folder_items", new=_copy_list),
        patch("mirage.core.box.copy.list_folder_items", new=_copy_list),
        patch("mirage.core.box.copy.copy_file", new=fake_copy_file),
        patch("mirage.core.box.copy.copy_folder", new=fake_copy_folder),
        patch("mirage.core.box.copy.delete_file", new=fake_delete_file),
        patch(
            "mirage.core.box.copy.invalidate_after_write",
            new=AsyncMock(side_effect=wrote),
        ),
        patch(
            "mirage.core.box.copy.invalidate_subtree",
            new=AsyncMock(side_effect=dropped),
        ),
    ):
        if raised is None:
            await copy(root_accessor, _spec(src), _spec(dst))
        else:
            with pytest.raises(raised):
                await copy(root_accessor, _spec(src), _spec(dst))
    assert events == expected


def _file_entry() -> dict:
    return {
        "type": "file",
        "id": "500",
        "name": "f.txt",
        "size": 5,
        "sha1": "s5",
        "modified_at": "2026-01-01T00:00:00Z",
        "etag": "1",
    }


# (upload reply, expected fingerprint) for 5 written bytes. "s5" is a
# token no local hash produces; a reply holding no file entry records none.
_BOX_REPLY_ROWS = [
    ({"total_count": 1, "entries": [_file_entry()]}, "s5"),
    ({"total_count": 0, "entries": []}, None),
    (["not", "a", "dict"], None),
    (None, None),
]
_BOX_REPLY_IDS = ["agrees", "no-entries", "non-dict", "empty-reply"]


async def _box_write_recorded(accessor, virtual: str, reply):
    order: list[tuple[str, int]] = []
    scope = RecordingScope()

    async def _spy(path):
        order.append(("invalidate", len(scope.records)))

    try:
        with (
            patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.write.upload_new_file",
                new_callable=AsyncMock,
                return_value=reply,
            ),
            patch(
                "mirage.core.box.write.upload_file_version",
                new_callable=AsyncMock,
                return_value=reply,
            ),
            patch("mirage.core.box.write.invalidate_after_write", new=_spy),
        ):
            await write(accessor, _spec(virtual), b"hello")
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    return rows, order


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "virtual", ["/data/new.txt", "/data/a.txt"], ids=["new", "version"]
)
@pytest.mark.parametrize(
    ("reply", "token"), _BOX_REPLY_ROWS, ids=_BOX_REPLY_IDS
)
async def test_write_records_the_reply_token(
    root_accessor, virtual, reply, token
):
    rows, order = await _box_write_recorded(root_accessor, virtual, reply)
    assert rows == [("write", virtual, 5, token, None)]
    # Recorded before the eviction, so the record exists when the cache
    # reacts to the write.
    assert order == [("invalidate", 1)]


@pytest.mark.asyncio
async def test_a_write_whose_reply_fails_still_evicts_the_path(root_accessor):
    # Box may have stored the bytes before the reply broke off, so the
    # cached copy is stale either way.
    scope = RecordingScope()
    evicted: list[str] = []

    async def _spy(path):
        evicted.append(path.virtual)

    try:
        with (
            patch("mirage.core.box.resolve.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.write.upload_file_version",
                new_callable=AsyncMock,
                side_effect=aiohttp.ClientPayloadError("reply cut off"),
            ),
            patch("mirage.core.box.write.invalidate_after_write", new=_spy),
            pytest.raises(aiohttp.ClientPayloadError),
        ):
            await write(root_accessor, _spec("/data/a.txt"), b"hello")
    finally:
        scope.close()
    assert evicted == ["/data/a.txt"]
    assert scope.records == []
