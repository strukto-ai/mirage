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
from mirage.ops import Ops
from mirage.resource.gdocs import GDocsConfig, GDocsResource


def _make_gdocs_ops() -> Ops:
    resource = GDocsResource(
        config=GDocsConfig(client_id="x", refresh_token="y"))
    return Workspace({"/gdocs/": resource}, mode=MountMode.READ).fs


@pytest.mark.asyncio
async def test_readdir_root():
    ops = _make_gdocs_ops()
    result = await ops.readdir("/gdocs/")
    assert "/gdocs/owned" in result
    assert "/gdocs/shared" in result


@pytest.mark.asyncio
async def test_read_doc():
    ops = _make_gdocs_ops()
    doc_json = json.dumps({"documentId": "doc1", "title": "Report"}).encode()
    with patch(
            "mirage.ops.gdocs.read.core_read",
            new_callable=AsyncMock,
            return_value=doc_json,
    ):
        result = await ops.read(
            "/gdocs/owned/2026-04-01_Report__doc1.gdoc.json")
        parsed = json.loads(result)
        assert parsed["documentId"] == "doc1"
