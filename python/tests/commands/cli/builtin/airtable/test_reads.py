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

from tests.fixtures.airtable_account import (
    DONE,
    DONE_FORMULA,
    FEATURES,
    MODEL_NOT_FOUND,
    OPS,
    ROADMAP,
)

BASE_DIR = "/at/bases/Product_Roadmap__appRoadmapBase001"
TABLE_DIR = f"{BASE_DIR}/Features__tblFeatures000001"
AT = f"--base {ROADMAP} --table {FEATURES}"
FIRST = "rec00000000000001"


async def _run(ws, line: str) -> tuple[int, str, str]:
    io = await ws.shell(line)
    return io.exit_code, await io.stdout_str(), await io.stderr_str()


@pytest.mark.asyncio
async def test_base_list_is_scoped_by_base_ids(airtable_ws):
    code, out, _ = await _run(
        airtable_ws(base_ids=[OPS]), "airtable base list"
    )
    assert code == 0
    assert json.loads(out) == [
        {
            "base_id": OPS,
            "base_name": "Ops / Finance ✓",
            "permission_level": "read",
        }
    ]


@pytest.mark.asyncio
async def test_base_and_table_get_print_the_mounts_own_files(airtable_ws):
    ws = airtable_ws()
    _, base, _ = await _run(ws, f"airtable base get {ROADMAP}")
    _, base_json, _ = await _run(ws, f"cat {BASE_DIR}/base.json")
    assert base == base_json
    for ref in (FEATURES, "Features"):
        _, table, _ = await _run(
            ws, f"airtable table get --base {ROADMAP} {ref}"
        )
        _, table_json, _ = await _run(ws, f"cat {TABLE_DIR}/table.json")
        assert table == table_json


@pytest.mark.asyncio
async def test_an_unknown_base_or_table_is_an_error(airtable_ws):
    ws = airtable_ws()
    assert await _run(ws, "airtable base get appNope0000000001") == (
        1,
        "",
        "airtable base get: appNope0000000001: no such base\n",
    )
    assert await _run(ws, f"airtable table get --base {ROADMAP} Nope") == (
        1,
        "",
        f"airtable table get: Nope: no such table in {ROADMAP}\n",
    )


@pytest.mark.asyncio
async def test_record_list_prints_records_jsonl_lines(airtable_ws):
    ws = airtable_ws()
    _, listed, _ = await _run(ws, f"airtable record list {AT}")
    _, mounted, _ = await _run(ws, f"cat {TABLE_DIR}/records.jsonl")
    assert listed == mounted
    assert len(listed.splitlines()) == 7


@pytest.mark.asyncio
async def test_the_read_cap_refuses_rather_than_paging(
    airtable_ws, airtable_account
):
    ws = airtable_ws(max_read_records=5)
    code, out, err = await _run(ws, f"airtable record list {AT}")
    assert (code, out) == (1, "")
    assert err == (
        "airtable record list: more than 5 records match "
        "(max_read_records); narrow them with --formula or --view,"
        " or take the first N with --max-records N\n"
    )
    assert [
        c["maxRecords"] for c in (await airtable_account.record_queries())
    ] == ["6"] * 2


@pytest.mark.asyncio
async def test_max_records_is_honored_as_asked(airtable_ws, airtable_account):
    ws = airtable_ws(max_read_records=5)
    code, out, _ = await _run(ws, f"airtable record list {AT} --max-records 7")
    assert code == 0
    assert len(out.splitlines()) == 7
    assert (await airtable_account.record_queries())[0]["maxRecords"] == "7"
    assert await _run(ws, f"airtable record list {AT} --max-records 0") == (
        2,
        "",
        "--max-records must be at least 1\n",
    )


@pytest.mark.asyncio
async def test_formula_and_view_pass_through(airtable_ws, airtable_account):
    ws = airtable_ws()
    code, out, _ = await _run(
        ws,
        f"airtable record list {AT} --view {DONE} "
        f'--formula "{DONE_FORMULA}" | jq -r .fields.Priority',
    )
    assert (code, out) == (0, "1\n3\n5\n7\n")
    call = (await airtable_account.record_queries())[0]
    assert (call["view"], call["filterByFormula"]) == (DONE, DONE_FORMULA)


@pytest.mark.asyncio
async def test_record_get_prints_one_line(airtable_ws):
    ws = airtable_ws()
    code, out, _ = await _run(ws, f"airtable record get {AT} {FIRST}")
    assert code == 0
    assert out.count("\n") == 1
    assert json.loads(out)["record_id"] == FIRST
    assert await _run(ws, f"airtable record get {AT} recZZZZZZZZZZZZZZ") == (
        1,
        "",
        "airtable record get: Airtable API error (GET "
        f"/{ROADMAP}/{FEATURES}/recZZZZZZZZZZZZZZ): HTTP 403: "
        f"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: {MODEL_NOT_FOUND}\n",
    )


@pytest.mark.asyncio
async def test_comment_list_is_normalized_in_api_order(airtable_ws):
    ws = airtable_ws()
    code, out, _ = await _run(ws, f"airtable comment list {AT} {FIRST}")
    assert code == 0
    comments = json.loads(out)
    assert [c["text"] for c in comments] == ["Shipped it.", "Looks good."]
    assert list(comments[0]) == [
        "comment_id",
        "author_id",
        "author_email",
        "author_name",
        "text",
        "created_time",
        "last_updated_time",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        f"airtable base get {OPS}",
        f"airtable table get --base {OPS} tblBudget00000001",
        f"airtable record list --base {OPS} --table tblBudget00000001",
        f"airtable record get --base {OPS} --table tblBudget00000001 {FIRST}",
        f"airtable comment list --base {OPS} --table tblBudget00000001 {FIRST}",
    ],
)
async def test_a_base_outside_the_scope_is_refused_unsent(
    airtable_ws, airtable_account, line
):
    ws = airtable_ws(base_ids=[ROADMAP])
    verb = " ".join(line.split()[:3])
    assert await _run(ws, line) == (
        1,
        "",
        f"{verb}: {OPS}: Permission denied\n",
    )
    assert await airtable_account.asked() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, message",
    [
        ("airtable base list extra", "unrecognized arguments: extra"),
        ("airtable base get", "the following arguments are required: BASE"),
        (
            f"airtable base get {ROADMAP} {OPS}",
            f"unrecognized arguments: {OPS}",
        ),
        (
            f"airtable table get --base {ROADMAP}",
            "the following arguments are required: TABLE",
        ),
        (
            f"airtable record get {AT}",
            "the following arguments are required: RECORD",
        ),
        (f"airtable comment list {AT} a b", "unrecognized arguments: b"),
    ],
)
async def test_operand_refusals_are_usage_errors(
    airtable_ws, airtable_account, line, message
):
    assert await _run(airtable_ws(), line) == (2, "", f"{message}\n")
    assert await airtable_account.asked() == []
