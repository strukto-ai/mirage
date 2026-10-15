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

import pytest

from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import copy
from mirage.core.box.mkdir import mkdir
from mirage.core.box.readdir import readdir
from mirage.core.box.rename import rename
from mirage.core.box.rmdir import rm_r, rmdir
from mirage.core.box.unlink import unlink
from mirage.core.box.write import write
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.box import BoxVFS
from mirage.vfs.box.config import BoxConfig
from mirage.workspace import Workspace
from tests.fixtures.handed import call

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


def _workspace(accessor) -> Workspace:
    vfs = BoxVFS(config=BoxConfig(access_token="test-token"))
    vfs.accessor = accessor
    return Workspace({"/d/": vfs}, mode=MountMode.WRITE)


@pytest.fixture
def root_accessor(accessor):
    # Mount root is the account root "0".
    return accessor


@pytest.mark.asyncio
async def test_write_new_file_uploads_under_parent(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.write.upload_new_file", new_callable=AsyncMock
        ) as up,
    ):
        await call(
            write, readdir, root_accessor, _spec("/data/new.txt"), b"hello"
        )
    up.assert_awaited_once_with(
        root_accessor.token_manager, "100", "new.txt", b"hello"
    )


@pytest.mark.asyncio
async def test_write_existing_file_uploads_version(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.write.upload_file_version", new_callable=AsyncMock
        ) as ver,
    ):
        await call(
            write, readdir, root_accessor, _spec("/data/a.txt"), b"OVER"
        )
    ver.assert_awaited_once_with(
        root_accessor.token_manager, "200", "a.txt", b"OVER", None
    )


@pytest.mark.asyncio
async def test_write_missing_parent_raises(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
    ):
        with pytest.raises(FileNotFoundError):
            await call(
                write, readdir, root_accessor, _spec("/data/ghost/x.txt"), b"x"
            )


@pytest.mark.asyncio
async def test_mkdir_creates_under_parent(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder",
            new_callable=AsyncMock,
            return_value={"id": "400", "name": "newdir", "type": "folder"},
        ) as cf,
    ):
        await call(mkdir, readdir, root_accessor, _spec("/data/newdir"))
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
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder", new_callable=AsyncMock
        ) as cf,
    ):
        with pytest.raises(error):
            await call(mkdir, readdir, root_accessor, _spec(virtual))
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
    # -p is the mount's: it makes one level at a time and names the file
    # it stops at above the operand, as GNU does.
    ws = _workspace(root_accessor)
    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.mkdir.create_folder", new_callable=AsyncMock
            ) as cf,
        ):
            with pytest.raises(error, match="'/d/data/a.txt'$"):
                await ws.dispatch(
                    "mkdir",
                    PathSpec.from_str_path("/d" + virtual),
                    parents=True,
                )
        cf.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mkdir_of_a_taken_name_is_eexist(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.mkdir.create_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("Box POST /folders -> 409", 409),
        ),
    ):
        with pytest.raises(FileExistsError):
            await call(mkdir, readdir, root_accessor, _spec("/data/a.txt"))


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
        return {"id": new_id, "name": name, "type": "folder"}

    ws = _workspace(root_accessor)
    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
            patch("mirage.core.box.mkdir.create_folder", new=fake_create),
        ):
            await ws.dispatch(
                "mkdir", PathSpec.from_str_path("/d/data/p/q"), parents=True
            )
        # Each level is handed the folder the level above made.
        assert created == [("100", "p"), ("new-p", "q")]
    finally:
        await ws.close()
        _TREE.pop("new-p", None)
        _TREE.pop("new-q", None)
        _TREE["100"] = [e for e in _TREE["100"] if e["name"] != "p"]


@pytest.mark.asyncio
async def test_unlink_deletes_file(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.unlink.delete_file", new_callable=AsyncMock
        ) as df,
    ):
        await call(unlink, readdir, root_accessor, _spec("/data/a.txt"))
    df.assert_awaited_once_with(root_accessor.token_manager, "200", None)


@pytest.mark.asyncio
async def test_unlink_on_folder_raises_isdir(root_accessor):
    with patch("mirage.core.box.readdir.list_folder_items", new=_fake_list):
        with pytest.raises(IsADirectoryError):
            await call(unlink, readdir, root_accessor, _spec("/data/sub"))


@pytest.mark.asyncio
async def test_rmdir_deletes_folder_non_recursive(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
    ):
        await call(rmdir, readdir, root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(
        root_accessor.token_manager, "300", recursive=False
    )


@pytest.mark.asyncio
async def test_rm_r_recursive_on_folder(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
    ):
        await call(rm_r, readdir, root_accessor, _spec("/data/sub"))
    df.assert_awaited_once_with(
        root_accessor.token_manager, "300", recursive=True
    )


@pytest.mark.asyncio
async def test_rename_moves_file(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rename.update_file", new_callable=AsyncMock
        ) as uf,
    ):
        await call(
            rename,
            readdir,
            root_accessor,
            _spec("/data/a.txt"),
            dst=_spec("/data/b.txt"),
        )
    uf.assert_awaited_once_with(
        root_accessor.token_manager, "200", name="b.txt", parent_id="100"
    )


@pytest.mark.asyncio
async def test_rename_replaces_empty_folder_destination(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
    ):
        await call(
            rename,
            readdir,
            root_accessor,
            _spec("/data/sub"),
            dst=_spec("/data/dst"),
        )
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
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("conflict", 409),
        ),
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
    ):
        with pytest.raises(OSError) as caught:
            await call(
                rename,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/dst"),
            )
    assert caught.value.errno == errno.ENOTEMPTY
    assert uo.await_count == 0


@pytest.mark.asyncio
async def test_rename_unmapped_folder_error_propagates(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder",
            new_callable=AsyncMock,
            side_effect=BoxApiError("boom", 500),
        ),
        patch("mirage.core.box.rename.update_folder", new_callable=AsyncMock),
    ):
        with pytest.raises(BoxApiError):
            await call(
                rename,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/dst"),
            )


@pytest.mark.asyncio
async def test_rename_file_onto_folder_raises_isdir(root_accessor):
    # rename(2) answers EISDIR for a file onto a directory whether or not
    # that directory has children, so the type check outranks emptiness and
    # the folder is never deleted to find out.
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.rmdir.delete_folder", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_file", new_callable=AsyncMock
        ) as uf,
    ):
        with pytest.raises(IsADirectoryError):
            await call(
                rename,
                readdir,
                root_accessor,
                _spec("/data/a.txt"),
                dst=_spec("/data/sub"),
            )
    assert df.await_count == 0
    assert uf.await_count == 0


@pytest.mark.asyncio
async def test_rename_folder_onto_file_raises_notdir(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
        patch(
            "mirage.core.box.rename.update_folder", new_callable=AsyncMock
        ) as uo,
    ):
        with pytest.raises(NotADirectoryError):
            await call(
                rename,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/a.txt"),
            )
    assert df.await_count == 0
    assert uo.await_count == 0


@pytest.mark.asyncio
async def test_copy_file_onto_folder_raises_isdir(root_accessor):
    # cp refuses a type mismatch rather than replacing: this branch used to
    # recursively delete the destination folder.
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch("mirage.core.box.copy.copy_file", new_callable=AsyncMock) as cf,
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
    ):
        with pytest.raises(IsADirectoryError):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/a.txt"),
                dst=_spec("/data/sub"),
            )
    assert cf.await_count == 0
    assert df.await_count == 0


@pytest.mark.asyncio
async def test_copy_folder_onto_file_raises_notdir(root_accessor):
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
        patch("mirage.core.box.copy.list_folder_items", new=_fake_list),
        patch(
            "mirage.core.box.copy.copy_folder", new_callable=AsyncMock
        ) as cd,
        patch(
            "mirage.core.box.copy.delete_file", new_callable=AsyncMock
        ) as df,
    ):
        with pytest.raises(NotADirectoryError):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/a.txt"),
            )
    assert cd.await_count == 0
    assert df.await_count == 0


@pytest.mark.asyncio
async def test_copy_file(root_accessor):
    scope = RecordingScope()
    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.copy.copy_file", new_callable=AsyncMock
            ) as cf,
        ):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/a.txt"),
                dst=_spec("/data/c.txt"),
            )
    finally:
        scope.close()
    cf.assert_awaited_once_with(
        root_accessor.token_manager, "200", "100", name="c.txt"
    )
    assert [(r.op, r.path) for r in scope.records] == [("copy", "/data/c.txt")]


@pytest.mark.asyncio
async def test_copy_of_a_whole_folder_is_recorded_as_a_prefix(root_accessor):
    scope = RecordingScope()
    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.copy.copy_folder", new_callable=AsyncMock
            ) as cd,
        ):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/new"),
            )
    finally:
        scope.close()
    cd.assert_awaited_once_with(
        root_accessor.token_manager, "300", "100", name="new"
    )
    assert [(r.op, r.path) for r in scope.records] == [
        ("copy_prefix", "/data/new")
    ]


@pytest.mark.asyncio
async def test_a_merge_records_each_folder_before_the_next(
    root_accessor,
):
    tree = {
        **_TREE,
        "300": [
            {"id": "310", "name": "x", "type": "folder"},
            {"id": "320", "name": "y", "type": "folder"},
        ],
    }

    async def listing(_tm, folder_id, limit=1000):
        return tree.get(folder_id, [])

    scope = RecordingScope()
    seen: list[list[tuple[str, str]]] = []

    async def copied(*_args, **_kwargs):
        seen.append([(r.op, r.path) for r in scope.records])

    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=listing),
            patch("mirage.core.box.copy.list_folder_items", new=listing),
            patch("mirage.core.box.copy.copy_folder", new=copied),
        ):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/sub"),
                dst=_spec("/data/dst"),
            )
    finally:
        scope.close()
    assert seen == [[], [("copy_prefix", "/data/dst/x")]]


@pytest.mark.asyncio
async def test_a_replaced_file_is_recorded_only_once_its_copy_lands(
    root_accessor,
):
    scope = RecordingScope()
    seen: list[list[tuple[str, str]]] = []

    async def copied(*_args, **_kwargs):
        seen.append([(r.op, r.path) for r in scope.records])
        return {}

    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_copy_list),
            patch("mirage.core.box.copy.copy_file", new=copied),
            patch("mirage.core.box.copy.delete_file", new_callable=AsyncMock),
        ):
            await call(
                copy,
                readdir,
                root_accessor,
                _spec("/data/a.txt"),
                dst=_spec("/data/b.txt"),
            )
    finally:
        scope.close()
    assert seen == [[]]
    assert [(r.op, r.path) for r in scope.records] == [("copy", "/data/b.txt")]


@pytest.mark.asyncio
async def test_a_rename_onto_its_own_name_sends_and_records_nothing(
    root_accessor,
):
    scope = RecordingScope()
    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
            patch(
                "mirage.core.box.rename.update_file", new_callable=AsyncMock
            ) as moved,
        ):
            await call(
                rename,
                readdir,
                root_accessor,
                _spec("/data/a.txt"),
                dst=_spec("/data/a.txt"),
            )
    finally:
        scope.close()
    moved.assert_not_awaited()
    assert scope.records == []


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(root_accessor):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        parent = FileStat(
            name="m", type=FileType.DIRECTORY, extra={"box_id": "100"}
        )
        with patch(
            "mirage.core.box.write.upload_new_file", new_callable=AsyncMock
        ):
            await write(root_accessor, spec, b"hello", parent=parent)
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
    scope = RecordingScope()

    try:
        with (
            patch("mirage.core.box.readdir.list_folder_items", new=_fake_list),
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
        ):
            await call(write, readdir, accessor, _spec(virtual), b"hello")
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    return rows


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
    rows = await _box_write_recorded(root_accessor, virtual, reply)
    assert rows == [("write", virtual, 5, token, None)]
