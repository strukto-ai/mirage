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

import mirage.core.gdrive.write as write_mod
from mirage.core.gdrive.write import write
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_write_creates_in_existing_parent(fake_drive, gdrive_accessor):
    fake_drive.folder("a")
    await write(gdrive_accessor, spec("/a/new.txt"), b"hello")
    item = fake_drive.find("new.txt")
    assert item is not None
    assert item["content"] == b"hello"


@pytest.mark.asyncio
async def test_write_overwrites_same_id(fake_drive, gdrive_accessor):
    file_id = fake_drive.add("f.txt", content=b"old")
    await write(gdrive_accessor, spec("/f.txt"), b"new")
    assert fake_drive.items[file_id]["content"] == b"new"
    assert len(fake_drive.items) == 1


@pytest.mark.asyncio
async def test_write_missing_parent_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await write(gdrive_accessor, spec("/no/f.txt"), b"x")


@pytest.mark.asyncio
async def test_write_to_folder_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await write(gdrive_accessor, spec("/d"), b"x")
    with pytest.raises(IsADirectoryError):
        await write(gdrive_accessor, spec("/"), b"x")


@pytest.mark.asyncio
async def test_write_to_native_raises(fake_drive, gdrive_accessor):
    fake_drive.add("Report", mime=DOC_MIME)
    with pytest.raises(PermissionError):
        await write(gdrive_accessor, spec("/Report.gdoc.json"), b"x")


@pytest.mark.asyncio
async def test_write_records_the_virtual_path(fake_drive, gdrive_accessor):
    # A folder named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    fake_drive.folder("m")
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        await write(gdrive_accessor, spec, b"hello")
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
    order: list[tuple[str, int]] = []
    scope = RecordingScope()

    async def _spy(path):
        order.append(("invalidate", len(scope.records)))

    monkeypatch.setattr(
        "mirage.core.gdrive.write.invalidate_after_write", _spy
    )
    try:
        await write(accessor, spec(virtual), data)
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    return rows, order


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
    rows, order = await _write_recorded(
        gdrive_accessor, "/f.txt", b"hello", monkeypatch
    )
    assert rows == [("write", "/f.txt", 5, token, None)]
    # Recorded before the eviction, so the record exists when the cache
    # reacts to the write.
    assert order == [("invalidate", 1)]


@pytest.mark.asyncio
async def test_a_write_whose_reply_fails_still_evicts_the_path(
    fake_drive, gdrive_accessor, monkeypatch
):
    # Drive may have stored the bytes before the reply broke off, so the
    # cached copy is stale either way.
    evicted: list[str] = []

    async def _cut_off(*args, **kwargs):
        raise aiohttp.ClientPayloadError("reply cut off")

    async def _spy(path):
        evicted.append(path.virtual)

    monkeypatch.setattr(write_mod, "upload_file", _cut_off)
    monkeypatch.setattr(write_mod, "invalidate_after_write", _spy)
    scope = RecordingScope()
    try:
        with pytest.raises(aiohttp.ClientPayloadError):
            await write(gdrive_accessor, spec("/f.txt"), b"hello")
    finally:
        scope.close()
    assert evicted == ["/f.txt"]
    assert scope.records == []
