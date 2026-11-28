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

import json

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, FileType
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace.files import Files

DOC = "application/vnd.google-apps.document"


def _make_gdrive_ops(google_account) -> tuple[Files, IndexCacheStore]:
    # The store to seed is the one the mount runs the driver under.
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    ws = Workspace({"/gdrive/": vfs}, mode=MountMode.READ)
    return ws.vfs, ws.mount("/gdrive/").index_store


def _row(name: str, file_id: str, resource_type: str) -> FileStat:
    return FileStat(
        name=name,
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": file_id, "resource_type": resource_type},
    )


@pytest.mark.asyncio
async def test_read_gdoc_via_filetype_cascade(google_account):
    made = await google_account.create("Report", DOC)
    ops, index = _make_gdrive_ops(google_account)
    await index.set_dir(
        "/gdrive/docs",
        [("report.gdoc.json", _row("report.gdoc.json", made, "gdrive/gdoc"))],
    )
    result = await ops.read("/gdrive/docs/report.gdoc.json")
    parsed = json.loads(result)
    assert parsed["documentId"] == made


@pytest.mark.asyncio
async def test_read_plain_file_falls_through(google_account):
    made = await google_account.upload("notes.txt", b"plain content")
    ops, index = _make_gdrive_ops(google_account)
    await index.set_dir(
        "/gdrive",
        [("notes.txt", _row("notes.txt", made, "gdrive/file"))],
    )
    # A cold read through the dispatcher fills the cache, so it asks for the
    # md5 its entry is stamped with, as a command's read does. The two go
    # out together, so the fake may meet them in either order.
    await google_account.run.record_requests()
    result = await ops.read("/gdrive/notes.txt")
    assert result == b"plain content"
    assert sorted(await google_account.log()) == [
        ("get", made),
        ("media", made),
    ]


@pytest.mark.asyncio
async def test_readdir(google_account):
    ops, index = _make_gdrive_ops(google_account)
    await index.set_dir(
        "/gdrive/docs",
        [
            (
                "report.gdoc.json",
                _row("report.gdoc.json", "doc123", "gdrive/gdoc"),
            )
        ],
    )
    await google_account.run.record_requests()
    result = await ops.readdir("/gdrive/docs")
    assert "/gdrive/docs/report.gdoc.json" in result
    assert await google_account.log() == []
