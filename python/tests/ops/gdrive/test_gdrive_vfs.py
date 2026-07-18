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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops import Ops
from mirage.ops.config import OpsMount
from mirage.ops.gdrive import OPS as GDRIVE_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import MountMode


def _make_gdrive_ops():
    accessor = GDriveAccessor(config=None, token_manager=None)
    index = RAMIndexCacheStore()
    ops_list = []
    for fn in GDRIVE_OPS:
        if isinstance(fn, RegisteredOp):
            ops_list.append(fn)
        elif hasattr(fn, "_registered_ops"):
            ops_list.extend(fn._registered_ops)
    mount = OpsMount(
        prefix="/gdrive/",
        resource_type="gdrive",
        accessor=accessor,
        index=index,
        mode=MountMode.READ,
        ops=ops_list,
    )
    return Ops([mount]), index


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
