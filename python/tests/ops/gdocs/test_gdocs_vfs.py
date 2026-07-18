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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops import Ops
from mirage.ops.config import OpsMount
from mirage.ops.gdocs import OPS as GDOCS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import MountMode


def _make_gdocs_ops():
    accessor = GDocsAccessor(config=None, token_manager=None)
    ops_list = []
    for fn in GDOCS_OPS:
        if isinstance(fn, RegisteredOp):
            ops_list.append(fn)
        elif hasattr(fn, "_registered_ops"):
            ops_list.extend(fn._registered_ops)
    mount = OpsMount(
        prefix="/gdocs/",
        resource_type="gdocs",
        accessor=accessor,
        index=RAMIndexCacheStore(),
        mode=MountMode.READ,
        ops=ops_list,
    )
    return Ops([mount])


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
