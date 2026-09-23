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

from mirage.core.gridfs import driver
from mirage.core.gridfs.read import read_bytes

FILE_ID = ObjectId("0123456789ab0123456789ab")
DOC = {"_id": FILE_ID, "length": 5, "uploadDate": None, "filename": "a.txt"}


class _Out:

    async def read(self, _size):
        return b"hello"

    async def close(self):
        return None


class _Bucket:

    async def open_download_stream(self, _file_id):
        return _Out()


@pytest.mark.asyncio
async def test_stat_and_read_stamp_the_same_token(monkeypatch):
    """GridFS is one of two backends claiming READ_REVALIDATABLE.

    The claim is that its stat and its read stamp a token that can be
    compared, and both use the file's ``_id`` today. Nothing failed if
    one side moved to an md5 or an uploadDate -- which is exactly the
    gdrive mismatch the flag exists to keep out.
    """

    async def fake_latest_file(_conn, _key):
        return DOC

    monkeypatch.setattr(driver, "latest_file", fake_latest_file)
    meta = await driver._head(object(), "a.txt")
    assert meta is not None

    records = []
    monkeypatch.setitem(read_bytes.__globals__, "latest_file",
                        fake_latest_file)
    monkeypatch.setitem(read_bytes.__globals__,
                        "bucket",
                        lambda _a, _c=None: _Bucket())
    monkeypatch.setitem(read_bytes.__globals__, "record",
                        lambda *a, **kw: records.append(kw.get("fingerprint")))

    from mirage.accessor.gridfs import GridFSConfig
    from mirage.types import PathSpec
    accessor = type(
        "A", (), {"config": GridFSConfig(uri="mongodb://h", database="d")})()
    data = await read_bytes(accessor, PathSpec.from_str_path("/a.txt"))

    assert data == b"hello"
    assert records == [str(FILE_ID)]
    assert meta.fingerprint == records[0], (
        "stat and read must stamp the same token, or a `fresh` gridfs "
        "mount refetches on every read forever")
