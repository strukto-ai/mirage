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
from bson import ObjectId

from mirage.core.gridfs.read import read
from mirage.core.gridfs.stream import read_stream
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.gridfs.config import GridFSConfig

FILE_ID = ObjectId("0123456789ab0123456789ab")
DOC = {"_id": FILE_ID, "length": 5, "uploadDate": None, "filename": "m/k.txt"}

# A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
SPEC = PathSpec(virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt")


class _Out:
    def __init__(self) -> None:
        self.done = False

    async def read(self, _size):
        if self.done:
            return b""
        self.done = True
        return b"hello"

    async def close(self):
        return None


class _Bucket:
    async def open_download_stream(self, _file_id):
        return _Out()


async def _latest_file(_conn, _key):
    return DOC


def _accessor():
    return type(
        "A", (), {"config": GridFSConfig(uri="mongodb://h", database="d")}
    )()


def _patch(monkeypatch, fn) -> None:
    monkeypatch.setitem(fn.__globals__, "latest_file", _latest_file)
    monkeypatch.setitem(
        fn.__globals__, "bucket", lambda _a, _c=None: _Bucket()
    )


@pytest.mark.asyncio
async def test_read_records_the_virtual_path(monkeypatch):
    _patch(monkeypatch, read)
    scope = RecordingScope()
    try:
        data = await read(_accessor(), SPEC)
    finally:
        scope.close()
    assert data == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


@pytest.mark.asyncio
async def test_stream_records_the_virtual_path(monkeypatch):
    _patch(monkeypatch, read_stream)
    scope = RecordingScope()
    try:
        chunks = [c async for c in read_stream(_accessor(), SPEC)]
    finally:
        scope.close()
    assert b"".join(chunks) == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
