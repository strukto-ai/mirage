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
from unittest.mock import AsyncMock

import pytest

from mirage.core.airtable.search import lines_containing
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.airtable_api import ROADMAP, make_accessor

ROOT = "/at"
TABLE = f"{ROOT}/bases/Product_Roadmap__appRoadmapBase001/Features__tblFeatures000001"
RECORDS = f"{TABLE}/records.jsonl"
DONE = f"{TABLE}/views/Done_shipped__viwDone0000000001.jsonl"
CELLS = ("RECORD_ID()", '{Name} & ""', '{Status} & ""')
DONE_IDS = [f"rec{n:014d}" for n in (1, 3, 5, 7)]


# The file's row as its folder's listing names it, which the mount hands.
ROW = FileStat(name="file", type=FileType.FILE)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0],
        vfs_path=mount_key(virtual, ROOT),
    )


def _formula(query: str, cells: tuple[str, ...] = CELLS) -> str:
    return "OR({})".format(
        ", ".join(f'SEARCH("{query}", LOWER({cell}))' for cell in cells)
    )


def _ids(body: bytes | None) -> list[str]:
    assert isinstance(body, bytes)
    return [json.loads(line)["record_id"] for line in body.splitlines()]


def _status_holds(query: str):
    return lambda r: query in r["fields"].get("Status", "").lower()


# Airtable lists only the records the formula names, as a read lists them;
# a view's file applies the view too.
@pytest.mark.asyncio
async def test_only_the_records_a_formula_names_are_listed(airtable_api):
    airtable_api.formulas[_formula("one")] = _status_holds("one")
    out = await lines_containing(make_accessor(), _spec(RECORDS), "one", ROW)
    assert _ids(out) == DONE_IDS
    call = airtable_api.record_calls()[-1]
    assert call["filterByFormula"] == _formula("one")
    assert call["maxRecords"] == "10001"


@pytest.mark.asyncio
async def test_a_view_file_lists_what_the_view_and_formula_name(airtable_api):
    airtable_api.formulas[_formula("ure")] = lambda r: True
    out = await lines_containing(make_accessor(), _spec(DONE), "ure", ROW)
    assert _ids(out) == DONE_IDS
    assert airtable_api.record_calls()[-1]["view"] == "viwDone0000000001"


# A link, an AI text or an attachment holds no space outside the text a
# formula reads of it: a text with a space leaves a link out and asks the
# others, and a single word reads the file.
@pytest.mark.asyncio
async def test_a_text_with_a_space_is_asked_of_a_table_with_links(
    airtable_api,
):
    airtable_api.tables[ROADMAP][0]["fields"] += [
        {
            "id": "fldRelease000001",
            "name": "Release",
            "type": "multipleRecordLinks",
        },
        {"id": "fldSummary000001", "name": "Summary", "type": "aiText"},
    ]
    cells = (*CELLS, '{Summary} & ""')
    airtable_api.formulas[_formula("lone plan", cells)] = lambda r: False
    accessor = make_accessor()
    out = await lines_containing(accessor, _spec(RECORDS), "lone plan", ROW)
    assert out == b""
    assert await lines_containing(accessor, _spec(RECORDS), "one", ROW) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, virtual",
    [
        ("name", RECORDS),
        ("atus", RECORDS),
        ("true", RECORDS),
        ("q4", RECORDS),
        ("add", RECORDS),
        ("one", f"{TABLE}/table.json"),
        ("one", f"{TABLE}/views/Nope__viwNope000000000001.jsonl"),
        ("zzz", RECORDS),
    ],
)
async def test_an_unsure_answer_reads_the_file(airtable_api, text, virtual):
    # A view no listing names is handed no row.
    row = None if "Nope" in virtual else ROW
    out = await lines_containing(make_accessor(), _spec(virtual), text, row)
    assert out is None


@pytest.mark.asyncio
async def test_more_matches_than_the_cap_read_the_file(airtable_api):
    airtable_api.formulas[_formula("one")] = _status_holds("one")
    out = await lines_containing(
        make_accessor(max_read_records=2),
        _spec(RECORDS),
        "one",
        ROW,
    )
    assert out is None


# A listing that times out or fails to connect leaves the file to a read.
@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TimeoutError(), OSError("reset")])
async def test_a_failed_listing_reads_the_file(
    airtable_api, monkeypatch, error
):
    monkeypatch.setattr(
        "mirage.core.airtable.search.list_records",
        AsyncMock(side_effect=error),
    )
    out = await lines_containing(make_accessor(), _spec(RECORDS), "one", ROW)
    assert out is None
