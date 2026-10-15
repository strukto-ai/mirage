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

from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.airtable import AirtableVFS
from mirage.workspace import Workspace
from tests.fixtures.airtable_api import make_accessor
from tests.fixtures.vfs_io import vfs_over

ROOT = "/at"
BASE = f"{ROOT}/bases/Product_Roadmap__appRoadmapBase001"
TABLE = f"{BASE}/Features__tblFeatures000001"


def _mounted() -> Workspace:
    return Workspace({f"{ROOT}/": vfs_over(AirtableVFS, make_accessor())})


async def _stat(ws: Workspace, path: str) -> FileStat:
    row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
    return row


@pytest.mark.asyncio
async def test_json_leaves_stat_at_their_rendered_size(airtable_api):
    ws = _mounted()
    for leaf in (f"{BASE}/base.json", f"{TABLE}/table.json"):
        info = await _stat(ws, leaf)
        body, _ = await ws.dispatch("read", PathSpec.from_str_path(leaf))
        assert info.type == FileType.FILE
        assert info.content == ContentType.JSON
        assert info.size == len(body)


@pytest.mark.asyncio
async def test_record_files_are_size_unknown(airtable_api):
    ws = _mounted()
    records = await _stat(ws, f"{TABLE}/records.jsonl")
    view = await _stat(
        ws, f"{TABLE}/views/Done_shipped__viwDone0000000001.jsonl"
    )
    assert records.size is None and view.size is None
    assert view.extra == {"view_id": "viwDone0000000001"}


@pytest.mark.asyncio
async def test_directories_stat_as_directories(airtable_api):
    ws = _mounted()
    for path in (f"{ROOT}/bases", BASE, TABLE, f"{TABLE}/views"):
        assert (await _stat(ws, path)).type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_an_unlisted_view_is_enoent(airtable_api):
    with pytest.raises(FileNotFoundError):
        await _stat(_mounted(), f"{TABLE}/views/Gone__viwGone0000000001.jsonl")
