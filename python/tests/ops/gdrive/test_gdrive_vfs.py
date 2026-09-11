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
from unittest.mock import AsyncMock, patch

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index import IndexCacheStore
from mirage.cache.index.config import IndexEntry
from mirage.ops import Ops
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource


def _make_gdrive_ops() -> tuple[Ops, IndexCacheStore]:
    # Mounting re-derives the resource's index from the workspace's
    # config, so the store to seed is the one the mount ends up with.
    resource = GoogleDriveResource(
        config=GoogleDriveConfig(client_id="x", refresh_token="y"))
    ws = Workspace({"/gdrive/": resource}, mode=MountMode.READ)
    return ws.fs, resource.index


@pytest.mark.asyncio
async def test_read_gdoc_via_filetype_cascade():
    ops, index = _make_gdrive_ops()
    await index.put(
        "/gdrive/docs/report.gdoc.json",
        IndexEntry(
            id="doc123",
            name="Report",
            resource_type="gdrive/gdoc",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="report.gdoc.json",
        ))
    doc_json = json.dumps({"documentId": "doc123", "title": "Report"}).encode()
    with patch(
            "mirage.core.gdrive.read.read_doc",
            new_callable=AsyncMock,
            return_value=doc_json,
    ):
        result = await ops.read("/gdrive/docs/report.gdoc.json")
        parsed = json.loads(result)
        assert parsed["documentId"] == "doc123"


@pytest.mark.asyncio
async def test_read_plain_file_falls_through():
    ops, index = _make_gdrive_ops()
    await index.put(
        "/gdrive/notes.txt",
        IndexEntry(
            id="file789",
            name="notes",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="notes.txt",
        ))
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=b"plain content",
    ):
        result = await ops.read("/gdrive/notes.txt")
        assert result == b"plain content"


@pytest.mark.asyncio
async def test_readdir():
    ops, index = _make_gdrive_ops()
    await index.set_dir("/gdrive/docs", [(
        "report.gdoc.json",
        IndexEntry(
            id="doc123",
            name="Report",
            resource_type="gdrive/gdoc",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="report.gdoc.json",
        ),
    )])
    result = await ops.readdir("/gdrive/docs")
    assert "/gdrive/docs/report.gdoc.json" in result
