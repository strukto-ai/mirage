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

import mirage.core.gdrive.write as write_mod
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.write import write
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.handed import call, entry_at

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_write_creates_in_existing_parent(fake_drive, gdrive_accessor):
    fake_drive.folder("a")
    await call(write, readdir, gdrive_accessor, spec("/a/new.txt"), b"hello")
    item = fake_drive.find("new.txt")
    assert item is not None
    assert item["content"] == b"hello"


@pytest.mark.asyncio
async def test_write_overwrites_same_id(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("f.txt", content=b"old")
    await call(write, readdir, gdrive_accessor, spec("/f.txt"), b"new")
    assert fake_drive.items[file_id]["content"] == b"new"
    assert len(fake_drive.items) == 1


@pytest.mark.asyncio
async def test_a_write_lands_on_the_file_at_the_path_now(
    fake_drive, gdrive_accessor
):
    # The listing named a.txt; another client then renamed that file to
    # b.txt and made a new a.txt. The write goes to the new a.txt.
    moved = fake_drive.add("a.txt", content=b"old")
    listed = await entry_at(readdir, gdrive_accessor, spec("/a.txt"))
    fake_drive.items[moved]["name"] = "b.txt"
    made = fake_drive.add("a.txt", content=b"other")
    await write(gdrive_accessor, spec("/a.txt"), b"new", entry=listed)
    assert fake_drive.items[made]["content"] == b"new"
    assert fake_drive.items[moved]["content"] == b"old"


@pytest.mark.asyncio
async def test_write_missing_parent_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await call(write, readdir, gdrive_accessor, spec("/no/f.txt"), b"x")


@pytest.mark.asyncio
async def test_write_to_folder_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await call(write, readdir, gdrive_accessor, spec("/d"), b"x")
    with pytest.raises(IsADirectoryError):
        await call(write, readdir, gdrive_accessor, spec("/"), b"x")


@pytest.mark.asyncio
async def test_write_to_native_raises(fake_drive, gdrive_accessor):
    fake_drive.add("Report", mime=DOC_MIME)
    with pytest.raises(PermissionError):
        await call(
            write, readdir, gdrive_accessor, spec("/Report.gdoc.json"), b"x"
        )


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(fake_drive, gdrive_accessor):
    # A folder named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    fake_drive.folder("m")
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        await call(write, readdir, gdrive_accessor, spec, b"hello")
    finally:
        scope.close()
    assert fake_drive.find("k.txt")["content"] == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


_HAPPY = {
    "size": "5",
    "md5Checksum": "m5",
    "headRevisionId": "r5",
    "mimeType": "text/plain",
}
# (overrides on the fake's `public()` reply, expected fingerprint) for 5
# written bytes. The literal tokens are ones no local hash produces.
_REPLY_ROWS = [
    ({}, "m5"),
    ({"md5Checksum": None}, "r5"),
    # A missing mimeType counts as a non-native file.
    ({"mimeType": None}, "m5"),
]
_REPLY_IDS = ["agrees", "no-md5-takes-head-revision", "no-mimetype"]


def _replying(fn, overrides):
    # The fake's own reply, rendered through `public()`, with the row's
    # fields replaced, or removed where the row says None.
    async def _call(*args, **kwargs):
        reply = dict(await fn(*args, **kwargs))
        for key, value in overrides.items():
            if value is None:
                reply.pop(key, None)
            else:
                reply[key] = value
        return reply

    return _call


async def _write_recorded(accessor, virtual: str, data: bytes, monkeypatch):
    scope = RecordingScope()
    try:
        await call(write, readdir, accessor, spec(virtual), data)
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    return rows


def _patch_replies(fake_drive, monkeypatch, overrides) -> None:
    monkeypatch.setattr(
        write_mod,
        "upload_file",
        _replying(fake_drive.upload_file, {**_HAPPY, **overrides}),
    )
    monkeypatch.setattr(
        write_mod,
        "update_file_content",
        _replying(fake_drive.update_file_content, {**_HAPPY, **overrides}),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [False, True], ids=["create", "update"])
@pytest.mark.parametrize(("overrides", "token"), _REPLY_ROWS, ids=_REPLY_IDS)
async def test_write_records_the_reply_token(
    fake_drive, gdrive_accessor, monkeypatch, existing, overrides, token
):
    if existing:
        fake_drive.add("f.txt", content=b"old")
    _patch_replies(fake_drive, monkeypatch, overrides)
    rows = await _write_recorded(
        gdrive_accessor, "/f.txt", b"hello", monkeypatch
    )
    assert rows == [("write", "/f.txt", 5, token, None)]


@pytest.mark.asyncio
async def test_a_write_whose_reply_is_empty_still_records_it(
    fake_drive, gdrive_accessor, monkeypatch
):
    # The upload landed, so the write counts even without a token: an
    # earlier write's claim on the path must not win.
    async def _empty(*args, **kwargs):
        await fake_drive.upload_file(*args, **kwargs)

    monkeypatch.setattr(write_mod, "upload_file", _empty)
    rows = await _write_recorded(
        gdrive_accessor, "/f.txt", b"hello", monkeypatch
    )
    assert rows == [("write", "/f.txt", 5, None, None)]
