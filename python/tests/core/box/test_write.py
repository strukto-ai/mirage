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
import hashlib
from unittest.mock import AsyncMock

import pytest

from mirage.cache.context import write_condition
from mirage.cache.types import (
    ABSENT_WRITE,
    MatchWrite,
    ReplaceRequest,
    WriteContext,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import copy
from mirage.core.box.mkdir import mkdir
from mirage.core.box.readdir import readdir
from mirage.core.box.rename import rename
from mirage.core.box.rmdir import rm_r, rmdir
from mirage.core.box.unlink import unlink
from mirage.core.box.write import replace, write
from mirage.errors.types import OperationNotSupportedError, StaleWriteError
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.box import BoxVFS
from mirage.vfs.box.config import BoxConfig
from mirage.workspace import Workspace
from tests.fixtures.handed import call, entry_at

HELLO = b"hello"
SHA_HELLO = hashlib.sha1(HELLO).hexdigest()
FOLDER_ROUTE = "/2.0/folders/:folder_id"
ITEMS_ROUTE = "/2.0/folders/:folder_id/items"
NEW_FILE_ROUTE = "/2.0/files/content"
VERSION_ROUTE = "/2.0/files/:file_id/content"
COPY_FILE_ROUTE = "/2.0/files/:file_id/copy"


async def _data(account) -> dict[str, str]:
    """``/data`` holding ``a.txt`` ("hello") and the empty ``sub`` and
    ``dst``, by name to id."""
    data = await account.mkdir("data")
    return {
        "data": data,
        "a.txt": await account.put("a.txt", HELLO, data),
        "sub": await account.mkdir("sub", data),
        "dst": await account.mkdir("dst", data),
    }


async def _changes(account) -> list[str]:
    """The requests since recording started that could change Box."""
    return [r for r in await account.run.requests() if not r.startswith("GET")]


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


def _workspace(accessor) -> Workspace:
    vfs = BoxVFS(config=BoxConfig(access_token="test-token"))
    vfs.accessor = accessor
    return Workspace({"/d/": vfs}, mode=MountMode.WRITE)


def _recorded(scope: RecordingScope) -> list[tuple[str, str]]:
    return [(r.op, r.path) for r in scope.records]


@pytest.mark.asyncio
async def test_create_only_write_refuses_without_native_support(account):
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(OperationNotSupportedError):
        await replace(
            account.accessor(),
            ReplaceRequest(_spec("/data/new.txt"), b"ours", ABSENT_WRITE),
        )
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_explicit_replacement_uses_its_condition_after_preparing_stream(
    account,
):
    ids = await _data(account)
    path = _spec("/data/a.txt")
    context = WriteContext(
        vfs="box",
        conditions=frozenset({"put"}),
        read_version=AsyncMock(return_value="cached"),
        read_versions=AsyncMock(return_value=["cached"]),
        drop=AsyncMock(),
        keep=AsyncMock(),
    )

    async def body():
        assert await write_condition(path, "put") == MatchWrite("cached")
        yield b"ours"

    token = bind_caller(current_caller().changed({"write_context": context}))
    try:
        await replace(
            account.accessor(),
            ReplaceRequest(path, body(), MatchWrite(SHA_HELLO)),
        )
        assert await write_condition(path, "put") == MatchWrite("cached")
    finally:
        reset_caller(token)
    assert await account.read(ids["a.txt"]) == b"ours"


@pytest.mark.asyncio
async def test_a_replacement_sends_the_etag_of_the_version_it_checked(
    account,
):
    # The check reads the listing Box gave just before another client's
    # version landed. If-Match carries the etag that listing named, so Box
    # refuses the upload and keeps the newer bytes.
    ids = await _data(account)
    before = await account.run.call("GET", f"/2.0/folders/{ids['data']}/items")
    await account.upload_version(ids["a.txt"], b"later")
    await account.run.answer_next("GET", ITEMS_ROUTE, 200, before)
    with pytest.raises(StaleWriteError):
        await replace(
            account.accessor(ids["data"]),
            ReplaceRequest(_spec("/a.txt"), b"ours", MatchWrite(SHA_HELLO)),
        )
    assert await account.read(ids["a.txt"]) == b"later"


@pytest.mark.asyncio
async def test_rejected_replacement_closes_started_source(account):
    closed = []
    path = _spec("/data/new.txt")

    async def body():
        try:
            yield b"head"
            yield b"tail"
        finally:
            closed.append(True)

    source = body()
    assert await anext(source) == b"head"
    with pytest.raises(OperationNotSupportedError):
        await replace(
            account.accessor(), ReplaceRequest(path, source, ABSENT_WRITE)
        )
    assert closed == [True]


@pytest.mark.asyncio
async def test_write_new_file_uploads_under_parent(account):
    ids = await _data(account)
    await call(
        write, readdir, account.accessor(), _spec("/data/new.txt"), HELLO
    )
    made = await account.child(ids["data"], "new.txt")
    assert await account.read(made["id"]) == HELLO


@pytest.mark.asyncio
async def test_write_existing_file_uploads_version(account):
    ids = await _data(account)
    await call(
        write, readdir, account.accessor(), _spec("/data/a.txt"), b"OVER"
    )
    assert await account.read(ids["a.txt"]) == b"OVER"
    assert await account.names(ids["data"]) == ["a.txt", "dst", "sub"]


@pytest.mark.asyncio
async def test_a_write_lands_on_the_file_at_the_path_now(account):
    # The listing named a.txt; another client then renamed it to b.txt and
    # made a new a.txt. The write goes to the new one.
    ids = await _data(account)
    accessor = account.accessor()
    listed = await entry_at(readdir, accessor, _spec("/data/a.txt"))
    await account.rename(ids["a.txt"], "b.txt")
    now = await account.put("a.txt", b"other", ids["data"])
    await write(accessor, _spec("/data/a.txt"), b"new", listed)
    assert await account.read(now) == b"new"
    assert await account.read(ids["a.txt"]) == HELLO


@pytest.mark.asyncio
async def test_write_missing_parent_raises(account):
    await _data(account)
    with pytest.raises(FileNotFoundError):
        await call(
            write,
            readdir,
            account.accessor(),
            _spec("/data/ghost/x.txt"),
            b"x",
        )


@pytest.mark.asyncio
async def test_mkdir_creates_under_parent(account):
    ids = await _data(account)
    await call(mkdir, readdir, account.accessor(), _spec("/data/newdir"))
    made = await account.child(ids["data"], "newdir")
    assert made["type"] == "folder"


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
    account, virtual, error
):
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(error):
        await call(mkdir, readdir, account.accessor(), _spec(virtual))
    assert await _changes(account) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("virtual", "error"),
    [
        ("/data/a.txt/x/y", NotADirectoryError),
        ("/data/a.txt", FileExistsError),
    ],
)
async def test_mkdir_parents_names_the_file_it_stops_at(
    account, virtual, error
):
    # -p is the mount's: it makes one level at a time and names the file
    # it stops at above the operand, as GNU does.
    await _data(account)
    ws = _workspace(account.accessor())
    try:
        await account.run.record_requests()
        with pytest.raises(error, match="'/d/data/a.txt'$"):
            await ws.dispatch(
                "mkdir",
                PathSpec.from_str_path("/d" + virtual),
                parents=True,
            )
        assert await _changes(account) == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mkdir_of_a_taken_name_is_eexist(account):
    # Box refuses the name with a 409, by a file as by a folder.
    ids = await _data(account)
    with pytest.raises(FileExistsError):
        await call(mkdir, readdir, account.accessor(), _spec("/data/a.txt"))
    assert await account.names(ids["data"]) == ["a.txt", "dst", "sub"]


@pytest.mark.asyncio
async def test_mkdir_parents_creates_each_missing_level(account):
    # Each level is made in the folder the level above made.
    ids = await _data(account)
    ws = _workspace(account.accessor())
    try:
        await ws.dispatch(
            "mkdir", PathSpec.from_str_path("/d/data/p/q"), parents=True
        )
    finally:
        await ws.close()
    p = await account.child(ids["data"], "p")
    assert await account.names(p["id"]) == ["q"]


@pytest.mark.asyncio
async def test_unlink_deletes_file(account):
    ids = await _data(account)
    await call(unlink, readdir, account.accessor(), _spec("/data/a.txt"))
    assert await account.names(ids["data"]) == ["dst", "sub"]


@pytest.mark.asyncio
async def test_unlink_on_folder_raises_isdir(account):
    ids = await _data(account)
    with pytest.raises(IsADirectoryError):
        await call(unlink, readdir, account.accessor(), _spec("/data/sub"))
    assert await account.names(ids["data"]) == ["a.txt", "dst", "sub"]


@pytest.mark.asyncio
async def test_rmdir_deletes_folder_non_recursive(account):
    # Non-recursive is Box's to enforce: a folder with a child stays.
    ids = await _data(account)
    await account.put("x.txt", b"x", ids["dst"])
    accessor = account.accessor()
    await call(rmdir, readdir, accessor, _spec("/data/sub"))
    with pytest.raises(OSError) as caught:
        await call(rmdir, readdir, accessor, _spec("/data/dst"))
    assert caught.value.errno == errno.ENOTEMPTY
    assert await account.names(ids["data"]) == ["a.txt", "dst"]


@pytest.mark.asyncio
async def test_rm_r_recursive_on_folder(account):
    ids = await _data(account)
    await account.put("x.txt", b"x", ids["sub"])
    await call(rm_r, readdir, account.accessor(), _spec("/data/sub"))
    assert await account.names(ids["data"]) == ["a.txt", "dst"]


@pytest.mark.asyncio
async def test_rename_moves_file(account):
    ids = await _data(account)
    await call(
        rename,
        readdir,
        account.accessor(),
        _spec("/data/a.txt"),
        dst=_spec("/data/b.txt"),
    )
    assert (await account.child(ids["data"], "b.txt"))["id"] == ids["a.txt"]
    assert await account.names(ids["data"]) == ["b.txt", "dst", "sub"]


@pytest.mark.asyncio
async def test_rename_replaces_empty_folder_destination(account):
    ids = await _data(account)
    await call(
        rename,
        readdir,
        account.accessor(),
        _spec("/data/sub"),
        dst=_spec("/data/dst"),
    )
    assert (await account.child(ids["data"], "dst"))["id"] == ids["sub"]
    assert await account.names(ids["data"]) == ["a.txt", "dst"]


@pytest.mark.asyncio
async def test_rename_refuses_nonempty_folder_destination(account):
    # Box decides the emptiness, not us: recursive=false 409s on a folder
    # with children, and that is mv's "Directory not empty".
    ids = await _data(account)
    await account.put("x.txt", b"x", ids["dst"])
    with pytest.raises(OSError) as caught:
        await call(
            rename,
            readdir,
            account.accessor(),
            _spec("/data/sub"),
            dst=_spec("/data/dst"),
        )
    assert caught.value.errno == errno.ENOTEMPTY
    assert await account.names(ids["data"]) == ["a.txt", "dst", "sub"]
    assert await account.names(ids["dst"]) == ["x.txt"]


@pytest.mark.asyncio
async def test_rename_unmapped_folder_error_propagates(account):
    ids = await _data(account)
    await account.run.answer_next("DELETE", FOLDER_ROUTE, 500)
    with pytest.raises(BoxApiError):
        await call(
            rename,
            readdir,
            account.accessor(),
            _spec("/data/sub"),
            dst=_spec("/data/dst"),
        )
    assert await account.names(ids["data"]) == ["a.txt", "dst", "sub"]


@pytest.mark.asyncio
async def test_rename_file_onto_folder_raises_isdir(account):
    # rename(2) answers EISDIR for a file onto a directory whether or not
    # that directory has children, so the type check outranks emptiness and
    # the folder is never deleted to find out.
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(IsADirectoryError):
        await call(
            rename,
            readdir,
            account.accessor(),
            _spec("/data/a.txt"),
            dst=_spec("/data/sub"),
        )
    assert await _changes(account) == []


@pytest.mark.asyncio
async def test_rename_folder_onto_file_raises_notdir(account):
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(NotADirectoryError):
        await call(
            rename,
            readdir,
            account.accessor(),
            _spec("/data/sub"),
            dst=_spec("/data/a.txt"),
        )
    assert await _changes(account) == []


@pytest.mark.asyncio
async def test_copy_file_onto_folder_raises_isdir(account):
    # cp refuses a type mismatch rather than replacing: this branch used to
    # recursively delete the destination folder.
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(IsADirectoryError):
        await call(
            copy,
            readdir,
            account.accessor(),
            _spec("/data/a.txt"),
            dst=_spec("/data/sub"),
        )
    assert await _changes(account) == []


@pytest.mark.asyncio
async def test_copy_folder_onto_file_raises_notdir(account):
    await _data(account)
    await account.run.record_requests()
    with pytest.raises(NotADirectoryError):
        await call(
            copy,
            readdir,
            account.accessor(),
            _spec("/data/sub"),
            dst=_spec("/data/a.txt"),
        )
    assert await _changes(account) == []


@pytest.mark.asyncio
async def test_copy_file(account):
    ids = await _data(account)
    scope = RecordingScope()
    try:
        await call(
            copy,
            readdir,
            account.accessor(),
            _spec("/data/a.txt"),
            dst=_spec("/data/c.txt"),
        )
    finally:
        scope.close()
    made = await account.child(ids["data"], "c.txt")
    assert await account.read(made["id"]) == HELLO
    assert _recorded(scope) == [("copy", "/data/c.txt")]


@pytest.mark.asyncio
async def test_copy_of_a_whole_folder_is_recorded_as_a_prefix(account):
    ids = await _data(account)
    await account.put("x.txt", b"x", ids["sub"])
    scope = RecordingScope()
    try:
        await call(
            copy,
            readdir,
            account.accessor(),
            _spec("/data/sub"),
            dst=_spec("/data/new"),
        )
    finally:
        scope.close()
    made = await account.child(ids["data"], "new")
    assert await account.names(made["id"]) == ["x.txt"]
    assert _recorded(scope) == [("copy_prefix", "/data/new")]


@pytest.mark.asyncio
async def test_a_merge_records_each_folder_before_the_next(account):
    # sub's x and y merge into dst one by one; dst's own y is a file, so
    # y stops the merge after x has landed. x is recorded by then.
    ids = await _data(account)
    await account.mkdir("x", ids["sub"])
    await account.mkdir("y", ids["sub"])
    await account.put("y", b"y", ids["dst"])
    scope = RecordingScope()
    try:
        with pytest.raises(NotADirectoryError):
            await call(
                copy,
                readdir,
                account.accessor(),
                _spec("/data/sub"),
                dst=_spec("/data/dst"),
            )
    finally:
        scope.close()
    assert await account.names(ids["dst"]) == ["x", "y"]
    assert _recorded(scope) == [("copy_prefix", "/data/dst/x")]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [None, 500], ids=["lands", "refused"])
async def test_a_replaced_file_is_recorded_only_once_its_copy_lands(
    account, status
):
    ids = await _data(account)
    await account.put("b.txt", b"other", ids["data"])
    if status is not None:
        await account.run.answer_next("POST", COPY_FILE_ROUTE, status)
    scope = RecordingScope()
    try:
        if status is None:
            await call(
                copy,
                readdir,
                account.accessor(),
                _spec("/data/a.txt"),
                dst=_spec("/data/b.txt"),
            )
        else:
            with pytest.raises(BoxApiError):
                await call(
                    copy,
                    readdir,
                    account.accessor(),
                    _spec("/data/a.txt"),
                    dst=_spec("/data/b.txt"),
                )
    finally:
        scope.close()
    if status is None:
        made = await account.child(ids["data"], "b.txt")
        assert await account.read(made["id"]) == HELLO
        assert _recorded(scope) == [("copy", "/data/b.txt")]
    else:
        assert _recorded(scope) == []


@pytest.mark.asyncio
async def test_a_rename_onto_its_own_name_sends_and_records_nothing(account):
    await _data(account)
    await account.run.record_requests()
    scope = RecordingScope()
    try:
        await call(
            rename,
            readdir,
            account.accessor(),
            _spec("/data/a.txt"),
            dst=_spec("/data/a.txt"),
        )
    finally:
        scope.close()
    assert await _changes(account) == []
    assert scope.records == []


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(account):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    ids = await _data(account)
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    parent = FileStat(
        name="m", type=FileType.DIRECTORY, extra={"box_id": ids["data"]}
    )
    scope = RecordingScope()
    try:
        await write(account.accessor(), spec, HELLO, parent=parent)
    finally:
        scope.close()
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
    assert "k.txt" in await account.names(ids["data"])


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


# (upload reply, expected fingerprint) for 5 written bytes: answers Box
# never gives but a client must read. "s5" is a token no local hash
# produces; a reply holding no file entry records none.
_BOX_REPLY_ROWS = [
    ({"total_count": 1, "entries": [_file_entry()]}, "s5"),
    ({"total_count": 0, "entries": []}, None),
    (["not", "a", "dict"], None),
    (None, None),
]
_BOX_REPLY_IDS = ["agrees", "no-entries", "non-dict", "empty-reply"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("virtual", "route"),
    [("/data/new.txt", NEW_FILE_ROUTE), ("/data/a.txt", VERSION_ROUTE)],
    ids=["new", "version"],
)
@pytest.mark.parametrize(
    ("reply", "token"), _BOX_REPLY_ROWS, ids=_BOX_REPLY_IDS
)
async def test_write_records_the_reply_token(
    account, virtual, route, reply, token
):
    await _data(account)
    # Posted whole rather than through answer_next, whose None is the
    # kit's own body: the empty reply is a JSON null.
    plan = {
        "method": "POST",
        "route": route,
        "status": 201,
        "body": reply,
    }
    await account.run.call("POST", "/_kit/faults", json={"plans": [plan]})
    scope = RecordingScope()
    try:
        await call(write, readdir, account.accessor(), _spec(virtual), HELLO)
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    assert rows == [("write", virtual, 5, token, None)]
