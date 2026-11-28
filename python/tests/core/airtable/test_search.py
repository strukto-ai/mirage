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

from mirage.core.airtable.search import lines_containing
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.clock import ManualClock
from mirage.utils.key_prefix import mount_key
from tests.fixtures.airtable_account import FEATURES
from tests.fixtures.airtable_account import RECORDS as ROUTE

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


# Airtable lists only the records the formula names, as a read lists them;
# a view's file applies the view too. The fake evaluates the formula: only
# Status, Done on the odd records, holds "one".
@pytest.mark.asyncio
async def test_only_the_records_a_formula_names_are_listed(airtable_account):
    out = await lines_containing(
        airtable_account.accessor(), _spec(RECORDS), "one", ROW
    )
    assert _ids(out) == DONE_IDS
    call = (await airtable_account.record_queries())[-1]
    assert call["filterByFormula"] == _formula("one")
    assert call["maxRecords"] == "10001"


@pytest.mark.asyncio
async def test_a_view_file_lists_what_the_view_and_formula_name(
    airtable_account,
):
    # Every name holds "ure" (Feature n), so the view decides.
    out = await lines_containing(
        airtable_account.accessor(), _spec(DONE), "ure", ROW
    )
    assert _ids(out) == DONE_IDS
    queries = await airtable_account.record_queries()
    assert queries[-1]["view"] == "viwDone0000000001"


# A link, an AI text or an attachment holds no space outside the text a
# formula reads of it: a text with a space leaves a link out and asks the
# others, and a single word reads the file.
@pytest.mark.asyncio
async def test_a_text_with_a_space_is_asked_of_a_table_with_links(
    airtable_account,
):
    # Fields no record here fills, added to the schema as a base admin
    # would; no request of this API adds one.
    for seq, (field, name, kind) in enumerate(
        [
            ("fldRelease0000001", "Release", "multipleRecordLinks"),
            ("fldSummary0000001", "Summary", "aiText"),
        ],
        start=10,
    ):
        await airtable_account.run.execute(
            "INSERT INTO AirtableField"
            " (tenant, id, tableId, name, type, seq)"
            " VALUES ('default', ?, ?, ?, ?, ?)",
            field,
            FEATURES,
            name,
            kind,
            seq,
        )
    await airtable_account.run.record_requests()
    accessor = airtable_account.accessor()
    out = await lines_containing(accessor, _spec(RECORDS), "lone plan", ROW)
    assert out == b""
    cells = (*CELLS, '{Summary} & ""')
    queries = await airtable_account.record_queries()
    assert queries[-1]["filterByFormula"] == _formula("lone plan", cells)
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
    ],
)
async def test_an_unsure_answer_reads_the_file(
    airtable_account, text, virtual
):
    # A view no listing names is handed no row.
    row = None if "Nope" in virtual else ROW
    out = await lines_containing(
        airtable_account.accessor(), _spec(virtual), text, row
    )
    assert out is None


# A formula Airtable refuses proves nothing, so the file is read; one it
# answers with no record is the answer, and no line holds the text.
@pytest.mark.asyncio
async def test_a_refused_formula_reads_the_file(airtable_account):
    await airtable_account.run.answer_next(
        "GET",
        ROUTE,
        422,
        {
            "error": {
                "type": "INVALID_FILTER_BY_FORMULA",
                "message": "The formula for filtering records is invalid",
            }
        },
    )
    out = await lines_containing(
        airtable_account.accessor(), _spec(RECORDS), "zzz", ROW
    )
    assert out is None


@pytest.mark.asyncio
async def test_a_text_no_record_holds_lists_nothing(airtable_account):
    out = await lines_containing(
        airtable_account.accessor(), _spec(RECORDS), "zzz", ROW
    )
    assert out == b""


@pytest.mark.asyncio
async def test_more_matches_than_the_cap_read_the_file(airtable_account):
    out = await lines_containing(
        airtable_account.accessor(max_read_records=2),
        _spec(RECORDS),
        "one",
        ROW,
    )
    assert out is None


# A listing that times out or fails to connect leaves the file to a read.
# Every attempt fails, each retry waiting on a manual clock.
@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "reset"])
async def test_a_failed_listing_reads_the_file(airtable_account, failure):
    await airtable_account.run.answer_next(
        "GET",
        ROUTE,
        200 if failure == "timeout" else None,
        times=50,
        delay_ms=1000 if failure == "timeout" else 0,
    )
    accessor = airtable_account.accessor(timeout=0.05)
    accessor.bind_clock(ManualClock(), object())
    out = await lines_containing(accessor, _spec(RECORDS), "one", ROW)
    assert out is None
