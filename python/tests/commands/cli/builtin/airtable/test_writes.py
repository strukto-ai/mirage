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

from tests.fixtures.airtable_account import FEATURES, OPS, RECORDS, ROADMAP

TABLE_DIR = (
    "/at/bases/Product_Roadmap__appRoadmapBase001/Features__tblFeatures000001"
)
AT = f"--base {ROADMAP} --table {FEATURES}"
FIRST = "rec00000000000001"


async def _run(ws, line: str) -> tuple[int, str, str]:
    io = await ws.shell(line)
    return io.exit_code, await io.stdout_str(), await io.stderr_str()


async def _lines(ws, path: str, rows: list[dict]) -> None:
    body = "".join(json.dumps(row) + "\n" for row in rows)
    await ws.shell(f"printf '%s' '{body}' > {path}")


def _named(n: int) -> list[dict]:
    return [{"fields": {"Name": f"New {i}"}} for i in range(1, n + 1)]


def _usage(message: str) -> tuple[int, str, str]:
    return (2, "", f"{message}\n")


@pytest.mark.asyncio
async def test_create_sends_ten_records_to_a_request(
    airtable_ws, airtable_account
):
    ws = airtable_ws()
    await _lines(ws, "/s/new.jsonl", _named(23))
    code, out, err = await _run(
        ws, f"airtable record create {AT} < /s/new.jsonl"
    )
    assert (code, err) == (0, "")
    created = [json.loads(line) for line in out.splitlines()]
    assert [r["fields"]["Name"] for r in created][-1] == "New 23"
    assert list(created[0]) == ["record_id", "created_time", "fields"]
    bodies = [body for _, body in await airtable_account.writes()]
    assert [len(b["records"]) for b in bodies] == [10, 10, 3]
    assert all("typecast" not in b for b in bodies)


@pytest.mark.asyncio
async def test_create_takes_one_record_and_typecast(
    airtable_ws, airtable_account
):
    ws = airtable_ws()
    code, out, _ = await _run(
        ws,
        f"airtable record create {AT} --typecast "
        '--fields \'{"Name": "x", "Priority": "4"}\'',
    )
    assert code == 0
    # Typecast turns the text "4" into the number field's 4.
    assert json.loads(out)["fields"] == {"Name": "x", "Priority": 4}
    assert (await airtable_account.writes())[0][1] == {
        "records": [{"fields": {"Name": "x", "Priority": "4"}}],
        "typecast": True,
    }


@pytest.mark.asyncio
async def test_a_mount_line_round_trips_through_update(
    airtable_ws, airtable_account
):
    ws = airtable_ws()
    code, out, _ = await _run(
        ws,
        f'jq -c \'select(.fields.Status == "Done") | '
        f".fields.Priority = 9' {TABLE_DIR}/records.jsonl | "
        f"airtable record update {AT} | jq -c '[.record_id, .fields.Priority]'",
    )
    assert code == 0
    assert out.splitlines()[0] == '["rec00000000000001",9]'
    assert [kind for kind, _ in (await airtable_account.writes())] == [
        "update"
    ]
    _, after, _ = await _run(
        ws,
        f"jq -r 'select(.fields.Priority == 9) | .record_id' "
        f"{TABLE_DIR}/records.jsonl",
    )
    assert after.splitlines() == [
        "rec00000000000001",
        "rec00000000000003",
        "rec00000000000005",
        "rec00000000000007",
    ]


@pytest.mark.asyncio
async def test_a_stdin_line_drops_computed_fields(
    airtable_ws, airtable_account
):
    # A computed field, added to the schema as a base admin would; no
    # request of this API adds one.
    await airtable_account.run.execute(
        "INSERT INTO AirtableField"
        " (tenant, id, tableId, name, type, options, seq)"
        " VALUES ('default', ?, ?, 'Ticket', 'formula', ?, 10)",
        "fldTicket00000001",
        FEATURES,
        json.dumps({"formula": '"FT-" & {Priority}'}),
    )
    await airtable_account.run.record_requests()
    ws = airtable_ws()
    await _lines(
        ws,
        "/s/one.jsonl",
        [
            {
                "record_id": FIRST,
                "created_time": "2026-01-01T09:00:00.000Z",
                "fields": {"Name": "Renamed", "Ticket": "FT-1"},
            }
        ],
    )
    code, _, _ = await _run(ws, f"airtable record update {AT} < /s/one.jsonl")
    assert code == 0
    body = (await airtable_account.writes())[0][1]
    assert body["records"] == [{"id": FIRST, "fields": {"Name": "Renamed"}}]
    await _run(
        ws,
        f"airtable record update {AT} {FIRST} "
        '--fields \'{"Ticket": "FT-9"}\'',
    )
    assert (await airtable_account.writes())[1][1]["records"][0]["fields"] == {
        "Ticket": "FT-9"
    }


@pytest.mark.asyncio
async def test_update_patches_one_record(airtable_ws, airtable_account):
    ws = airtable_ws()
    code, out, _ = await _run(
        ws,
        f"airtable record update {AT} {FIRST} --fields '{{\"Priority\": 0}}'",
    )
    assert code == 0
    assert json.loads(out)["fields"]["Name"] == "Feature 1"
    assert json.loads(out)["fields"]["Priority"] == 0
    assert (await airtable_account.writes())[0][0] == "update"


@pytest.mark.asyncio
async def test_delete_takes_operands_or_stdin_lines(
    airtable_ws, airtable_account
):
    ws = airtable_ws()
    code, out, _ = await _run(ws, f"airtable record delete {AT} {FIRST}")
    assert (code, out) == (
        0,
        '{"record_id":"rec00000000000001","deleted":true}\n',
    )
    await _run(ws, f"cat {TABLE_DIR}/records.jsonl > /s/all.jsonl")
    code, out, _ = await _run(
        ws, f"airtable record delete {AT} < /s/all.jsonl"
    )
    assert (code, len(out.splitlines())) == (0, 6)
    assert await airtable_account.records(ROADMAP, FEATURES) == []


@pytest.mark.asyncio
async def test_deletes_go_ten_to_a_request(airtable_ws, airtable_account):
    ws = airtable_ws()
    await _lines(ws, "/s/new.jsonl", _named(5))
    await _run(ws, f"airtable record create {AT} < /s/new.jsonl")
    ids = " ".join(
        r["id"] for r in await airtable_account.records(ROADMAP, FEATURES)
    )
    code, out, _ = await _run(ws, f"airtable record delete {AT} {ids}")
    assert (code, len(out.splitlines())) == (0, 12)
    deletes = [
        named
        for kind, named in await airtable_account.writes()
        if kind == "delete"
    ]
    assert [len(named) for named in deletes] == [10, 2]


@pytest.mark.asyncio
async def test_a_failed_batch_still_prints_what_landed(
    airtable_ws, airtable_account
):
    ws = airtable_ws()
    await _lines(
        ws, "/s/new.jsonl", _named(10) + [{"fields": {"Nope": 1}}] + _named(2)
    )
    code, out, err = await _run(
        ws, f"airtable record create {AT} < /s/new.jsonl"
    )
    assert code == 1
    assert len(out.splitlines()) == 10
    assert err == (
        "Airtable API error (POST "
        f"/{ROADMAP}/{FEATURES}): HTTP 422: UNKNOWN_FIELD_NAME: "
        'Unknown field name: "Nope"\n'
    )
    assert len(await airtable_account.records(ROADMAP, FEATURES)) == 17


@pytest.mark.asyncio
async def test_a_write_is_never_retried_on_a_502(
    airtable_ws, airtable_account
):
    await airtable_account.run.answer_next(
        "POST", RECORDS, 502, {"error": {"type": "BAD_GATEWAY"}}
    )
    code, out, err = await _run(
        airtable_ws(), f"airtable record create {AT} --fields '{{}}'"
    )
    assert (code, out) == (1, "")
    assert "HTTP 502" in err
    assert len(await airtable_account.writes()) == 1


@pytest.mark.asyncio
async def test_comment_add_takes_text_or_stdin(airtable_ws, airtable_account):
    ws = airtable_ws()
    code, out, _ = await _run(
        ws, f"airtable comment add {AT} {FIRST} --text 'from a flag'"
    )
    assert (code, json.loads(out)["text"]) == (0, "from a flag")
    await _run(ws, f"printf 'piped\\n\\n' | airtable comment add {AT} {FIRST}")
    await _run(ws, f"printf 'bare' | airtable comment add {AT} {FIRST}")
    texts = [body["text"] for _, body in await airtable_account.writes()]
    assert texts == ["from a flag", "piped\n", "bare"]
    _, listed, _ = await _run(ws, f"airtable comment list {AT} {FIRST}")
    assert json.loads(listed)[0]["text"] == "bare"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, message",
    [
        (
            f"airtable record create {AT}",
            "--fields or records on stdin are required",
        ),
        (
            f"airtable record create {AT} --fields '[1]'",
            "--fields must be a JSON object",
        ),
        (
            f"airtable record create {AT} --fields '{{bad'",
            "--fields must be valid JSON",
        ),
        (
            f"airtable record create {AT} --fields NaN",
            "--fields must be valid JSON",
        ),
        (
            f"airtable record create {AT} x --fields '{{}}'",
            "unrecognized arguments: x",
        ),
        (
            f"airtable record update {AT} {FIRST}",
            "--fields is required with RECORD",
        ),
        (
            f"airtable record update {AT} --fields '{{}}'",
            "RECORD is required with --fields",
        ),
        (
            f"airtable record update {AT}",
            "RECORD --fields or records on stdin are required",
        ),
        (
            f"airtable record delete {AT}",
            "RECORD or records on stdin are required",
        ),
        (
            f"airtable comment add {AT} {FIRST}",
            "--text or text on stdin is required",
        ),
        (
            f"airtable comment add {AT} {FIRST} --text ''",
            "the comment text is empty",
        ),
        (
            f"airtable comment add {AT} --text hi",
            "the following arguments are required: RECORD",
        ),
    ],
)
async def test_missing_or_malformed_input_is_a_usage_error(
    airtable_ws, airtable_account, line, message
):
    " ".join(line.split()[1:3])
    assert await _run(airtable_ws(), line) == _usage(message)
    assert await airtable_account.asked() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "verb, text, message",
    [
        (
            "create",
            '{"fields": {}}\n\nnot json\n',
            "stdin line 3: not valid JSON",
        ),
        ("create", "[]\n", "stdin line 1: not a JSON object"),
        (
            "create",
            '{"id": "rec1", "fields": {}}\n',
            'stdin line 1: unknown key "id"',
        ),
        (
            "create",
            '{"fields": [1]}\n',
            'stdin line 1: "fields" must be an object',
        ),
        (
            "create",
            '{"record_id": "rec1"}\n',
            'stdin line 1: "fields" is required',
        ),
        (
            "update",
            '{"fields": {}}\n',
            'stdin line 1: "record_id" is required',
        ),
        (
            "update",
            '{"record_id": 7, "fields": {}}\n',
            'stdin line 1: "record_id" must be a string',
        ),
        (
            "update",
            '{"record_id": "rec1"}\n',
            'stdin line 1: "fields" is required',
        ),
        (
            "delete",
            '{"fields": {}}\n',
            'stdin line 1: "record_id" is required',
        ),
        (
            "delete",
            '{"record_id": "rec1", "fields": 3}\n',
            'stdin line 1: "fields" must be an object',
        ),
    ],
)
async def test_every_stdin_line_is_checked_before_anything_is_sent(
    airtable_ws, airtable_account, verb, text, message
):
    ws = airtable_ws()
    await ws.shell(f"printf '%s' '{text}' > /s/in.jsonl")
    assert await _run(
        ws, f"airtable record {verb} {AT} < /s/in.jsonl"
    ) == _usage(message)
    assert await airtable_account.asked() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        f"airtable record create --base {OPS} --table t --fields '{{}}'",
        f"airtable record update --base {OPS} --table t {FIRST} --fields '{{}}'",
        f"airtable record delete --base {OPS} --table t {FIRST}",
        f"airtable comment add --base {OPS} --table t {FIRST} --text hi",
    ],
)
async def test_a_write_outside_the_scope_is_refused_unsent(
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
