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

import hashlib

import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.write import write
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.google_account import UPLOAD, UPLOAD_FILE
from tests.fixtures.handed import call, entry_at

DOC_MIME = "application/vnd.google-apps.document"
HELLO_MD5 = hashlib.md5(b"hello").hexdigest()


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_write_creates_in_existing_parent(google_account):
    await google_account.folder("a")
    await call(
        write,
        readdir,
        google_account.drive_accessor(),
        spec("/a/new.txt"),
        b"hello",
    )
    item = await google_account.find("new.txt")
    assert item is not None
    assert await google_account.content(item["id"]) == b"hello"


@pytest.mark.asyncio
async def test_write_overwrites_same_id(google_account):
    file_id = await google_account.upload("f.txt", b"old")
    await call(
        write, readdir, google_account.drive_accessor(), spec("/f.txt"), b"new"
    )
    assert await google_account.content(file_id) == b"new"
    assert len(await google_account.items()) == 1


@pytest.mark.asyncio
async def test_a_write_lands_on_the_file_at_the_path_now(google_account):
    # The listing named a.txt; another client then renamed that file to
    # b.txt and made a new a.txt. The write goes to the new a.txt.
    moved = await google_account.upload("a.txt", b"old")
    accessor = google_account.drive_accessor()
    listed = await entry_at(readdir, accessor, spec("/a.txt"))
    await google_account.patch(moved, name="b.txt")
    made = await google_account.upload("a.txt", b"other")
    await write(accessor, spec("/a.txt"), b"new", entry=listed)
    assert await google_account.content(made) == b"new"
    assert await google_account.content(moved) == b"old"


@pytest.mark.asyncio
async def test_write_missing_parent_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            write,
            readdir,
            google_account.drive_accessor(),
            spec("/no/f.txt"),
            b"x",
        )


@pytest.mark.asyncio
async def test_write_to_folder_raises(google_account):
    await google_account.folder("d")
    accessor = google_account.drive_accessor()
    with pytest.raises(IsADirectoryError):
        await call(write, readdir, accessor, spec("/d"), b"x")
    with pytest.raises(IsADirectoryError):
        await call(write, readdir, accessor, spec("/"), b"x")


@pytest.mark.asyncio
async def test_write_to_native_raises(google_account):
    await google_account.create("Report", DOC_MIME)
    with pytest.raises(PermissionError):
        await call(
            write,
            readdir,
            google_account.drive_accessor(),
            spec("/Report.gdoc.json"),
            b"x",
        )


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(google_account):
    # A folder named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    await google_account.folder("m")
    path = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        await call(
            write, readdir, google_account.drive_accessor(), path, b"hello"
        )
    finally:
        scope.close()
    made = await google_account.find("k.txt")
    assert await google_account.content(made["id"]) == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


async def _write_recorded(google_account, virtual: str, data: bytes):
    scope = RecordingScope()
    try:
        await call(
            write,
            readdir,
            google_account.drive_accessor(),
            spec(virtual),
            data,
        )
    finally:
        scope.close()
    return [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]


# The fields Drive's answer to the write leaves out, and the token it is
# recorded under, for 5 written bytes.
_REPLY_ROWS = [
    ((), "md5"),
    (("md5Checksum",), "revision"),
    (("mimeType",), "md5"),
]
_REPLY_IDS = ["agrees", "no-md5-takes-head-revision", "no-mimetype"]


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [False, True], ids=["create", "update"])
@pytest.mark.parametrize(("dropped", "token"), _REPLY_ROWS, ids=_REPLY_IDS)
async def test_write_records_the_reply_token(
    google_account, existing, dropped, token
):
    if existing:
        await google_account.upload("f.txt", b"old")
    # Drive's answer for a file holding these five bytes, kept elsewhere,
    # answered for the write with the fields the row drops left out.
    model = await google_account.item(
        await google_account.upload(
            "f.txt", b"hello", await google_account.folder("elsewhere")
        )
    )
    if dropped:
        reply = {k: v for k, v in model.items() if k not in dropped}
        await google_account.run.answer_next(
            "PATCH" if existing else "POST",
            UPLOAD_FILE if existing else UPLOAD,
            200,
            reply,
        )
    rows = await _write_recorded(google_account, "/f.txt", b"hello")
    expected = HELLO_MD5 if token == "md5" else model["headRevisionId"]
    assert rows == [("write", "/f.txt", 5, expected, None)]


@pytest.mark.asyncio
async def test_a_write_whose_reply_is_empty_still_records_it(google_account):
    # The upload landed, so the write counts even without a token: an
    # earlier write's claim on the path must not win.
    await google_account.run.answer_next("POST", UPLOAD, 200, b"")
    rows = await _write_recorded(google_account, "/f.txt", b"hello")
    assert rows == [("write", "/f.txt", 5, None, None)]
