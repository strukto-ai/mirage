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
import re

import pytest

from mirage import Workspace
from mirage.core.gcal.day import parse_bucket
from mirage.core.render.json import compact_json_bytes
from mirage.vfs.gcal.config import GCalConfig
from mirage.vfs.gcal.gcal import GCalVFS
from tests.fixtures.gcal_seed import TODAY, calendar, gcal_config

__all__ = ["calendar"]

EVENT = "/cal/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs, part",
    [
        ({}, slice(None)),
        ({"raw": True}, slice(None)),
        ({"offset": 2, "size": 10}, slice(2, 12)),
    ],
    ids=["whole", "raw", "range"],
)
async def test_the_dispatcher_reads_an_event_cold(calendar, kwargs, part):
    # gcal's read is the by-VFS op: an event resolves as ".json" at the
    # dispatcher, so a read keyed to ".gcal.json" was never picked and a cold
    # read raised ENOTSUP until a cat warmed the file cache.
    whole = compact_json_bytes(await calendar.event_item("aaaa1"))
    ws = Workspace({"/cal": GCalVFS(gcal_config(calendar))})
    assert await ws.vfs.read(EVENT, **kwargs) == whole[part]


@pytest.mark.asyncio
async def test_the_dispatcher_reads_calendar_json_cold(calendar):
    ws = Workspace({"/cal": GCalVFS(gcal_config(calendar))})
    body = json.loads(await ws.vfs.read("/cal/primary/calendar.json"))
    assert body["bucketTimeZone"] == "Asia/Hong_Kong"


@pytest.mark.parametrize("size", [1, 7, 30])
@pytest.mark.asyncio
async def test_vfs_md_shows_the_mount_s_own_tree(size):
    # The tree is the mount's own shape, drawn without a request.
    config = GCalConfig(
        client_id="cid", refresh_token="rt", today=TODAY, bucket_days=size
    )
    vfs = GCalVFS(config)
    text = await Workspace({"/cal": vfs}).vfs_md()
    example = re.search(
        r"primary/\s+calendar\.json\s+(\S+)/\s+<eventId>__(\S+)", text
    )
    assert example is not None
    assert parse_bucket(example[1], size) is not None
    assert example[2].startswith("2026-08-11_") is (size > 1)
