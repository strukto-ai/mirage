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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.airtable.read import read
from mirage.errors.types import FileTooLargeError
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.airtable_api import make_accessor

ROOT = "/at"
BASE = f"{ROOT}/bases/Product_Roadmap__appRoadmapBase001"
TABLE = f"{BASE}/Features__tblFeatures000001"
RECORDS = f"{TABLE}/records.jsonl"
DONE = f"{TABLE}/views/Done_shipped__viwDone0000000001.jsonl"


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0],
        vfs_path=mount_key(virtual, ROOT),
    )


def _ids(body: bytes) -> list[str]:
    return [json.loads(line)["record_id"] for line in body.splitlines()]


@pytest.mark.asyncio
async def test_records_render_every_record_across_pages(airtable_api):
    body = await read(make_accessor(), _spec(RECORDS), RAMIndexCacheStore())
    assert len(_ids(body)) == 7
    first = json.loads(body.splitlines()[0])
    assert first == {
        "record_id": "rec00000000000001",
        "created_time": "2026-01-01T09:00:00.000Z",
        "fields": {"Name": "Feature 1", "Priority": 1, "Status": "Done"},
    }


@pytest.mark.asyncio
async def test_a_limit_fetches_only_that_many_records(airtable_api):
    body = await read(
        make_accessor(), _spec(RECORDS), RAMIndexCacheStore(), limit=2
    )
    assert _ids(body) == ["rec00000000000001", "rec00000000000002"]
    calls = airtable_api.record_calls()
    assert len(calls) == 1 and calls[0]["maxRecords"] == "2"


@pytest.mark.asyncio
async def test_a_view_file_applies_the_view(airtable_api):
    body = await read(make_accessor(), _spec(DONE), RAMIndexCacheStore())
    assert len(_ids(body)) == 4
    assert airtable_api.record_calls()[0]["view"] == "viwDone0000000001"


@pytest.mark.asyncio
async def test_a_full_read_past_the_cap_is_refused(airtable_api):
    accessor = make_accessor(max_read_records=5)
    with pytest.raises(FileTooLargeError):
        await read(accessor, _spec(RECORDS), RAMIndexCacheStore())
    # the refusal needed cap + 1 records, not the whole table
    assert airtable_api.record_calls()[-1]["maxRecords"] == "6"
    # a head-sized window still reads under the cap
    body = await read(accessor, _spec(RECORDS), RAMIndexCacheStore(), limit=3)
    assert len(_ids(body)) == 3


@pytest.mark.asyncio
async def test_a_window_past_the_cap_on_a_small_view_reads(airtable_api):
    body = await read(
        make_accessor(max_read_records=5),
        _spec(DONE),
        RAMIndexCacheStore(),
        limit=50,
    )
    assert len(_ids(body)) == 4


@pytest.mark.asyncio
async def test_an_offset_skips_records(airtable_api):
    body = await read(
        make_accessor(),
        _spec(RECORDS),
        RAMIndexCacheStore(),
        limit=2,
        offset=3,
    )
    assert _ids(body) == ["rec00000000000004", "rec00000000000005"]


@pytest.mark.asyncio
async def test_missing_tables_and_views_read_as_enoent(airtable_api):
    accessor = make_accessor()
    for path in (
        f"{BASE}/Gone__tblGone0000000001/records.jsonl",
        f"{TABLE}/views/Gone__viwGone0000000001.jsonl",
        f"{BASE}/Gone__tblGone0000000001/table.json",
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _spec(path), RAMIndexCacheStore())


@pytest.mark.asyncio
async def test_a_base_outside_base_ids_is_enoent_on_read(airtable_api):
    accessor = make_accessor(base_ids=["appOpsFinance0001"])
    for path in (RECORDS, f"{BASE}/base.json", f"{TABLE}/table.json"):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _spec(path), RAMIndexCacheStore())
    assert airtable_api.record_calls() == []


@pytest.mark.asyncio
async def test_a_name_the_listing_does_not_hold_is_enoent(airtable_api):
    accessor = make_accessor()
    ops = f"{ROOT}/bases/Ops_Finance__appOpsFinance0001"
    for path in (
        f"{ROOT}/bases/Wrong__appRoadmapBase001/base.json",
        f"{BASE}/Wrong__tblFeatures000001/table.json",
        f"{BASE}/Wrong__tblFeatures000001/records.jsonl",
        f"{TABLE}/views/Wrong__viwDone0000000001.jsonl",
        f"{ops}/Q3_Budget__tblBudget00000001/views/"
        "Grid_view__viwGrid0000000001.jsonl",
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _spec(path), RAMIndexCacheStore())
    # the ids resolve at the API; only the listing knows the names
    assert airtable_api.record_calls() == []


@pytest.mark.asyncio
async def test_a_read_without_an_index_still_proves_the_path(airtable_api):
    body = await read(make_accessor(), _spec(DONE))
    assert len(_ids(body)) == 4
    with pytest.raises(FileNotFoundError):
        await read(
            make_accessor(),
            _spec(f"{BASE}/Wrong__tblFeatures000001/records.jsonl"),
        )


@pytest.mark.asyncio
async def test_a_view_gone_since_its_listing_is_enoent(airtable_api):
    # the schema still lists the view; Airtable answers its id missing
    airtable_api.views.pop("viwDone0000000001")
    with pytest.raises(FileNotFoundError):
        await read(make_accessor(), _spec(DONE), RAMIndexCacheStore())
