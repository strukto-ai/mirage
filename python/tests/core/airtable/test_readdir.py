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

from mirage.core.airtable.readdir import readdir
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.airtable import AirtableVFS
from mirage.workspace import Workspace
from tests.fixtures.airtable_api import make_accessor
from tests.fixtures.vfs_io import vfs_over

ROOT = "/at"
BASE = f"{ROOT}/bases/Product_Roadmap__appRoadmapBase001"
TABLE = f"{BASE}/Features__tblFeatures000001"


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=mount_key(virtual, ROOT)
    )


def _names(rows: list[FileStat]) -> list[str]:
    return [row.name for row in rows]


def _mounted(**overrides) -> Workspace:
    return Workspace(
        {f"{ROOT}/": vfs_over(AirtableVFS, make_accessor(**overrides))}
    )


@pytest.mark.asyncio
async def test_the_root_is_the_bases_directory(airtable_api):
    listed = await readdir(make_accessor(), _spec(f"{ROOT}/"))
    assert _names(listed) == ["bases"]


@pytest.mark.asyncio
async def test_bases_list_as_named_directories(airtable_api):
    listed = await readdir(make_accessor(), _spec(f"{ROOT}/bases"))
    assert _names(listed) == [
        "Product_Roadmap__appRoadmapBase001",
        "Ops_Finance__appOpsFinance0001",
    ]


@pytest.mark.asyncio
async def test_a_base_lists_base_json_and_its_tables(airtable_api):
    accessor = make_accessor()
    base, _ = await readdir(accessor, _spec(f"{ROOT}/bases"))
    listed = await readdir(accessor, _spec(BASE), base)
    assert _names(listed.entries) == [
        "base.json",
        "Features__tblFeatures000001",
    ]


@pytest.mark.asyncio
async def test_one_schema_call_seeds_every_table_and_views_dir(airtable_api):
    ws = _mounted()
    await ws.dispatch("readdir", PathSpec.from_str_path(BASE))
    before = len(airtable_api.calls)
    table, _ = await ws.dispatch("readdir", PathSpec.from_str_path(TABLE))
    views, _ = await ws.dispatch(
        "readdir", PathSpec.from_str_path(f"{TABLE}/views")
    )
    assert len(airtable_api.calls) == before
    assert table == [
        f"{TABLE}/table.json",
        f"{TABLE}/records.jsonl",
        f"{TABLE}/views",
    ]
    assert views == [
        f"{TABLE}/views/Grid_view__viwGrid0000000001.jsonl",
        f"{TABLE}/views/Done_shipped__viwDone0000000001.jsonl",
    ]


@pytest.mark.asyncio
async def test_a_cold_table_listing_warms_through_its_base(airtable_api):
    listed, _ = await _mounted().dispatch(
        "readdir", PathSpec.from_str_path(TABLE)
    )
    assert f"{TABLE}/records.jsonl" in listed


@pytest.mark.asyncio
async def test_an_unknown_or_out_of_scope_base_is_enoent(airtable_api):
    with pytest.raises(FileNotFoundError):
        await _mounted().dispatch(
            "readdir",
            PathSpec.from_str_path(f"{ROOT}/bases/X__appNope000000001"),
        )
    with pytest.raises(FileNotFoundError):
        await _mounted(base_ids=["appOpsFinance0001"]).dispatch(
            "readdir", PathSpec.from_str_path(BASE)
        )
