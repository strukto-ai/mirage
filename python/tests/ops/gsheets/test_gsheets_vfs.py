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
from mirage.resource.gsheets import GSheetsConfig, GSheetsResource


def _make_gsheets_ops() -> tuple[Ops, IndexCacheStore]:
    # Mounting re-derives the resource's index from the workspace's
    # config, so the store to seed is the one the mount ends up with.
    resource = GSheetsResource(
        config=GSheetsConfig(client_id="x", refresh_token="y"))
    ws = Workspace({"/gsheets/": resource}, mode=MountMode.READ)
    return ws.fs, resource.index


@pytest.mark.asyncio
async def test_readdir():
    ops, index = _make_gsheets_ops()
    await index.set_dir("/gsheets/owned", [(
        "Budget__sheet1.gsheet.json",
        IndexEntry(
            id="sheet1",
            name="Budget",
            resource_type="gsheets/sheet",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="Budget__sheet1.gsheet.json",
        ),
    )])
    result = await ops.readdir("/gsheets/owned")
    assert "/gsheets/owned/Budget__sheet1.gsheet.json" in result


@pytest.mark.asyncio
async def test_read_spreadsheet():
    ops, _ = _make_gsheets_ops()
    sheet_json = json.dumps({"spreadsheetId": "sheet1"}).encode()
    with patch(
            "mirage.ops.gsheets.read.core_read",
            new_callable=AsyncMock,
            return_value=sheet_json,
    ):
        result = await ops.read("/gsheets/owned/Budget__sheet1.gsheet.json")
        parsed = json.loads(result)
        assert parsed["spreadsheetId"] == "sheet1"
