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
from mirage.resource.gslides import GSlidesConfig, GSlidesResource


def _make_gslides_ops() -> tuple[Ops, IndexCacheStore]:
    # Mounting re-derives the resource's index from the workspace's
    # config, so the store to seed is the one the mount ends up with.
    resource = GSlidesResource(
        config=GSlidesConfig(client_id="x", refresh_token="y"))
    ws = Workspace({"/gslides/": resource}, mode=MountMode.READ)
    return ws.fs, resource.index


@pytest.mark.asyncio
async def test_readdir():
    ops, index = _make_gslides_ops()
    await index.set_dir("/gslides/owned", [(
        "Deck__slide1.gslide.json",
        IndexEntry(
            id="slide1",
            name="Deck",
            resource_type="gslides/slide",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="Deck__slide1.gslide.json",
        ),
    )])
    result = await ops.readdir("/gslides/owned")
    assert "/gslides/owned/Deck__slide1.gslide.json" in result


@pytest.mark.asyncio
async def test_read_presentation():
    ops, _ = _make_gslides_ops()
    pres_json = json.dumps({"presentationId": "slide1"}).encode()
    with patch(
            "mirage.ops.gslides.read.core_read",
            new_callable=AsyncMock,
            return_value=pres_json,
    ):
        result = await ops.read("/gslides/owned/Deck__slide1.gslide.json")
        parsed = json.loads(result)
        assert parsed["presentationId"] == "slide1"
