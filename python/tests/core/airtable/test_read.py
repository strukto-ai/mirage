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

from mirage.core.airtable.read import read, read_stream
from mirage.errors.types import FileTooLargeError
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.airtable import AirtableVFS
from mirage.workspace import Workspace
from tests.fixtures.airtable_api import make_accessor
from tests.fixtures.vfs_io import vfs_over

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


# The rows the mount hands a read: the file's, as its folder's listing
# names it, and its folder's.
ROW = FileStat(name="file", type=FileType.FILE)
DIR = FileStat(name="dir", type=FileType.DIRECTORY)


def _mounted(**overrides) -> Workspace:
    accessor = make_accessor(**overrides)
    return Workspace({f"{ROOT}/": vfs_over(AirtableVFS, accessor)})


async def _mounted_read(ws: Workspace, path: str) -> bytes:
    data, _ = await ws.dispatch("read", PathSpec.from_str_path(path))
    return data


def _ids(body: bytes) -> list[str]:
    return [json.loads(line)["record_id"] for line in body.splitlines()]


@pytest.mark.asyncio
async def test_records_render_every_record_across_pages(airtable_api):
    body = await read(make_accessor(), _spec(RECORDS), ROW, DIR)
    assert len(_ids(body)) == 7
    first = json.loads(body.splitlines()[0])
    assert first == {
        "record_id": "rec00000000000001",
        "created_time": "2026-01-01T09:00:00.000Z",
        "fields": {"Name": "Feature 1", "Priority": 1, "Status": "Done"},
    }


@pytest.mark.asyncio
async def test_a_limit_fetches_only_that_many_records(airtable_api):
    body = await read(make_accessor(), _spec(RECORDS), ROW, DIR, limit=2)
    assert _ids(body) == ["rec00000000000001", "rec00000000000002"]
    calls = airtable_api.record_calls()
    assert len(calls) == 1 and calls[0]["maxRecords"] == "2"


@pytest.mark.asyncio
async def test_a_view_file_applies_the_view(airtable_api):
    body = await read(make_accessor(), _spec(DONE), ROW, DIR)
    assert len(_ids(body)) == 4
    assert airtable_api.record_calls()[0]["view"] == "viwDone0000000001"


@pytest.mark.asyncio
async def test_a_full_read_past_the_cap_is_refused(airtable_api):
    accessor = make_accessor(max_read_records=5)
    with pytest.raises(FileTooLargeError):
        await read(accessor, _spec(RECORDS), ROW, DIR)
    # the refusal needed cap + 1 records, not the whole table
    assert airtable_api.record_calls()[-1]["maxRecords"] == "6"
    # a head-sized window still reads under the cap
    body = await read(accessor, _spec(RECORDS), ROW, DIR, limit=3)
    assert len(_ids(body)) == 3


@pytest.mark.asyncio
async def test_a_window_past_the_cap_on_a_small_view_reads(airtable_api):
    body = await read(
        make_accessor(max_read_records=5),
        _spec(DONE),
        ROW,
        DIR,
        limit=50,
    )
    assert len(_ids(body)) == 4


@pytest.mark.asyncio
async def test_an_offset_skips_records(airtable_api):
    body = await read(
        make_accessor(),
        _spec(RECORDS),
        ROW,
        DIR,
        limit=2,
        offset=3,
    )
    assert _ids(body) == ["rec00000000000004", "rec00000000000005"]


@pytest.mark.asyncio
async def test_missing_tables_and_views_read_as_enoent(airtable_api):
    ws = _mounted()
    for path in (
        f"{BASE}/Gone__tblGone0000000001/records.jsonl",
        f"{TABLE}/views/Gone__viwGone0000000001.jsonl",
        f"{BASE}/Gone__tblGone0000000001/table.json",
    ):
        with pytest.raises(FileNotFoundError):
            await _mounted_read(ws, path)


@pytest.mark.asyncio
async def test_a_base_outside_base_ids_is_enoent_on_read(airtable_api):
    ws = _mounted(base_ids=["appOpsFinance0001"])
    for path in (RECORDS, f"{BASE}/base.json", f"{TABLE}/table.json"):
        with pytest.raises(FileNotFoundError):
            await _mounted_read(ws, path)
    assert airtable_api.record_calls() == []


@pytest.mark.asyncio
async def test_a_name_the_listing_does_not_hold_is_enoent(airtable_api):
    ws = _mounted()
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
            await _mounted_read(ws, path)
    # the ids resolve at the API; only the listing knows the names
    assert airtable_api.record_calls() == []


@pytest.mark.asyncio
async def test_a_read_with_no_rows_handed_proves_nothing(airtable_api):
    for path in (DONE, RECORDS):
        with pytest.raises(FileNotFoundError):
            await read(make_accessor(), _spec(path))
    assert airtable_api.record_calls() == []


@pytest.mark.asyncio
async def test_a_view_gone_since_its_listing_is_enoent(airtable_api):
    # the schema still lists the view; Airtable answers its id missing
    airtable_api.views.pop("viwDone0000000001")
    with pytest.raises(FileNotFoundError):
        await read(make_accessor(), _spec(DONE), ROW, DIR)


@pytest.mark.asyncio
async def test_a_stream_renders_the_read_a_page_at_a_time(airtable_api):
    accessor = make_accessor()
    chunks = [c async for c in read_stream(accessor, _spec(RECORDS), ROW, DIR)]
    assert [len(_ids(c)) for c in chunks] == [3, 3, 1]
    assert b"".join(chunks) == await read(accessor, _spec(RECORDS), ROW, DIR)


@pytest.mark.asyncio
async def test_a_stream_stops_paging_when_the_reader_stops(airtable_api):
    stream = read_stream(make_accessor(), _spec(RECORDS), ROW, DIR)
    first = await anext(stream)
    await stream.aclose()
    assert len(_ids(first)) == 3
    assert len(airtable_api.record_calls()) == 1


@pytest.mark.asyncio
async def test_a_stream_past_the_cap_stops_after_that_many_records(
    airtable_api,
):
    got: list[bytes] = []
    with pytest.raises(FileTooLargeError):
        async for chunk in read_stream(
            make_accessor(max_read_records=5),
            _spec(RECORDS),
            ROW,
            DIR,
        ):
            got.append(chunk)
    assert len(_ids(b"".join(got))) == 5
    assert airtable_api.record_calls()[-1]["maxRecords"] == "6"


@pytest.mark.asyncio
async def test_a_stream_applies_a_view_and_proves_its_paths(airtable_api):
    accessor = make_accessor()
    body = b"".join(
        [c async for c in read_stream(accessor, _spec(DONE), ROW, DIR)]
    )
    assert len(_ids(body)) == 4
    ws = _mounted()
    for path in (
        f"{BASE}/Gone__tblGone0000000001/records.jsonl",
        f"{TABLE}/views/Gone__viwGone0000000001.jsonl",
    ):
        result = await ws.shell(f"cat < {path}")
        assert result.exit_code == 1
        assert "No such file or directory" in await result.stderr_str()


@pytest.mark.asyncio
async def test_a_stream_of_another_file_is_its_read(airtable_api):
    accessor = make_accessor()
    chunks = [
        c
        async for c in read_stream(
            accessor, _spec(f"{TABLE}/table.json"), ROW, DIR
        )
    ]
    assert chunks == [
        await read(accessor, _spec(f"{TABLE}/table.json"), ROW, DIR)
    ]
