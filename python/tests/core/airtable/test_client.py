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

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from mirage.core.airtable.client import (
    RETRY,
    WRITE_RETRY,
    create_comment,
    create_records,
    delete_records,
    get_record,
    list_bases,
    list_comments,
    list_records,
    list_tables,
    update_records,
)
from mirage.core.airtable.errors import AirtableAPIError
from tests.fixtures.airtable_account import (
    COMMENTS,
    DONE_FORMULA,
    FEATURES,
    MODEL_NOT_FOUND,
    OPS,
    RECORDS,
    ROADMAP,
)

FIRST = "rec00000000000001"


async def _drain(batches: AsyncIterator[list[dict[str, Any]]]) -> list[int]:
    return [len(batch) async for batch in batches]


def _names(n: int) -> list[dict[str, Any]]:
    return [{"Name": f"New {i}"} for i in range(1, n + 1)]


async def _features(account) -> list[dict[str, Any]]:
    return await account.records(ROADMAP, FEATURES)


def test_the_retry_policy_vetoes_only_the_billing_cap():
    assert RETRY.retryable is not None
    assert RETRY.retryable(429, '{"error": {"type": "RATE_LIMIT_REACHED"}}')
    assert not RETRY.retryable(
        429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}'
    )
    assert RETRY.min_delays[429] == 30.0


@pytest.mark.asyncio
async def test_list_bases_honors_the_configured_scope(airtable_account):
    everything = await list_bases(airtable_account.accessor())
    assert [b["id"] for b in everything] == [ROADMAP, OPS]
    scoped = await list_bases(airtable_account.accessor(base_ids=[OPS]))
    assert [b["id"] for b in scoped] == [OPS]


@pytest.mark.asyncio
async def test_a_bad_token_names_the_call_and_the_type(airtable_account):
    with pytest.raises(AirtableAPIError) as exc:
        await list_bases(airtable_account.accessor(token="wrong"))
    assert exc.value.status == 401
    assert exc.value.error_type == "AUTHENTICATION_REQUIRED"
    assert str(exc.value) == (
        "Airtable API error (GET /meta/bases): HTTP 401: "
        "AUTHENTICATION_REQUIRED: Authentication required"
    )


@pytest.mark.asyncio
async def test_list_tables_returns_the_schema(airtable_account):
    tables = await list_tables(airtable_account.accessor(), ROADMAP)
    assert [t["id"] for t in tables] == [FEATURES]


@pytest.mark.asyncio
async def test_list_records_pages_through_every_offset(airtable_account):
    records = await list_records(
        airtable_account.accessor(), ROADMAP, FEATURES
    )
    assert len(records) == 7
    calls = await airtable_account.record_queries()
    assert len(calls) == 3
    assert "offset" not in calls[0]
    assert calls[1]["offset"] and calls[2]["offset"] != calls[1]["offset"]
    assert all(c["pageSize"] == "100" for c in calls)


@pytest.mark.asyncio
async def test_max_records_rides_the_wire_and_the_collector(airtable_account):
    records = await list_records(
        airtable_account.accessor(), ROADMAP, FEATURES, max_records=2
    )
    assert [r["id"] for r in records] == [
        "rec00000000000001",
        "rec00000000000002",
    ]
    assert (await airtable_account.record_queries())[0]["maxRecords"] == "2"


@pytest.mark.asyncio
async def test_a_view_filters_through_the_api(airtable_account):
    records = await list_records(
        airtable_account.accessor(),
        ROADMAP,
        FEATURES,
        view="viwDone0000000001",
    )
    assert [r["fields"]["Priority"] for r in records] == [1, 3, 5, 7]


@pytest.mark.asyncio
async def test_a_formula_rides_the_wire(airtable_account):
    records = await list_records(
        airtable_account.accessor(), ROADMAP, FEATURES, formula=DONE_FORMULA
    )
    assert [r["fields"]["Priority"] for r in records] == [1, 3, 5, 7]
    queries = await airtable_account.record_queries()
    assert queries[0]["filterByFormula"] == DONE_FORMULA


@pytest.mark.asyncio
async def test_a_table_name_is_as_good_as_its_id(airtable_account):
    records = await list_records(
        airtable_account.accessor(), ROADMAP, "Features"
    )
    assert len(records) == 7


@pytest.mark.asyncio
async def test_get_record_reads_one_by_id(airtable_account):
    accessor = airtable_account.accessor()
    record = await get_record(accessor, ROADMAP, FEATURES, FIRST)
    assert record["fields"]["Name"] == "Feature 1"
    with pytest.raises(AirtableAPIError) as exc:
        await get_record(accessor, ROADMAP, FEATURES, "recZZZZZZZZZZZZZZ")
    assert exc.value.status == 403
    assert exc.value.not_found
    assert str(exc.value) == (
        f"Airtable API error (GET /{ROADMAP}/{FEATURES}/recZZZZZZZZZZZZZZ): "
        f"HTTP 403: INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: {MODEL_NOT_FOUND}"
    )


@pytest.mark.asyncio
async def test_creates_go_ten_to_a_request(airtable_account):
    sizes = await _drain(
        create_records(
            airtable_account.accessor(), ROADMAP, FEATURES, _names(23)
        )
    )
    assert sizes == [10, 10, 3]
    bodies = [body for _, body in await airtable_account.writes()]
    assert [len(b["records"]) for b in bodies] == [10, 10, 3]
    assert bodies[0]["records"][0] == {"fields": {"Name": "New 1"}}
    assert all("typecast" not in b for b in bodies)
    assert len(await _features(airtable_account)) == 30


@pytest.mark.asyncio
async def test_typecast_is_a_body_key(airtable_account):
    accessor = airtable_account.accessor()
    await _drain(
        create_records(accessor, ROADMAP, FEATURES, _names(1), typecast=True)
    )
    await _drain(
        update_records(
            accessor,
            ROADMAP,
            FEATURES,
            [(FIRST, {"Priority": 9})],
            typecast=True,
        )
    )
    assert [b["typecast"] for _, b in await airtable_account.writes()] == [
        True,
        True,
    ]


@pytest.mark.asyncio
async def test_updates_patch_ten_to_a_request(airtable_account):
    ids = [r["id"] for r in await _features(airtable_account)]
    updates = [(record_id, {"Priority": 0}) for record_id in ids * 2][:12]
    sizes = await _drain(
        update_records(airtable_account.accessor(), ROADMAP, FEATURES, updates)
    )
    assert sizes == [10, 2]
    calls = await airtable_account.writes()
    assert [kind for kind, _ in calls] == ["update", "update"]
    assert calls[0][1]["records"][0] == {
        "id": FIRST,
        "fields": {"Priority": 0},
    }
    first = (await _features(airtable_account))[0]
    assert first["fields"]["Name"] == "Feature 1"


@pytest.mark.asyncio
async def test_deletes_ride_records_brackets_ten_to_a_request(
    airtable_account,
):
    accessor = airtable_account.accessor()
    await _drain(create_records(accessor, ROADMAP, FEATURES, _names(5)))
    ids = [r["id"] for r in await _features(airtable_account)]
    sizes = await _drain(delete_records(accessor, ROADMAP, FEATURES, ids))
    assert sizes == [10, 2]
    deletes = [
        named
        for kind, named in await airtable_account.writes()
        if kind == "delete"
    ]
    assert deletes == [ids[:10], ids[10:]]
    assert await _features(airtable_account) == []


@pytest.mark.asyncio
async def test_a_failed_batch_stops_after_what_landed(airtable_account):
    rows = _names(10) + [{"Nope": 1}] + _names(2)
    landed: list[int] = []
    with pytest.raises(AirtableAPIError) as exc:
        async for batch in create_records(
            airtable_account.accessor(), ROADMAP, FEATURES, rows
        ):
            landed.append(len(batch))
    assert landed == [10]
    assert exc.value.error_type == "UNKNOWN_FIELD_NAME"
    assert len(await airtable_account.writes()) == 2
    assert len(await _features(airtable_account)) == 17


@pytest.mark.asyncio
async def test_a_write_never_retries_a_503(airtable_account):
    await airtable_account.run.answer_next(
        "POST", RECORDS, 503, {"error": {"type": "SERVICE_UNAVAILABLE"}}
    )
    with pytest.raises(AirtableAPIError) as exc:
        await _drain(
            create_records(
                airtable_account.accessor(), ROADMAP, FEATURES, _names(1)
            )
        )
    assert exc.value.status == 503
    assert len(await airtable_account.writes()) == 1


@pytest.mark.asyncio
async def test_a_write_waits_out_a_429_and_retries_it(
    airtable_account, monkeypatch
):
    waits: list[float] = []
    sleep = asyncio.sleep

    async def _no_wait(seconds: float) -> None:
        # The retry's own wait is recorded and skipped; any other sleep (the
        # socket's own) still yields.
        if seconds:
            waits.append(seconds)
        else:
            await sleep(0)

    await airtable_account.run.answer_next(
        "POST", RECORDS, 429, {"error": {"type": "RATE_LIMIT_REACHED"}}
    )
    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    sizes = await _drain(
        create_records(
            airtable_account.accessor(), ROADMAP, FEATURES, _names(1)
        )
    )
    assert sizes == [1]
    assert len(await airtable_account.writes()) == 2
    assert waits == [30.0]


def test_the_write_policy_retries_only_the_429():
    assert WRITE_RETRY.statuses == frozenset({429})
    assert WRITE_RETRY.min_delays[429] == 30.0
    assert WRITE_RETRY.retryable is not None
    assert not WRITE_RETRY.retryable(
        429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}'
    )
    assert {502, 503} <= RETRY.statuses


@pytest.mark.asyncio
async def test_comments_page_newest_first(airtable_account):
    accessor = airtable_account.accessor()
    for n in range(3):
        await create_comment(accessor, ROADMAP, FEATURES, FIRST, f"note {n}")
    await airtable_account.run.record_requests()
    comments = await list_comments(accessor, ROADMAP, FEATURES, FIRST)
    assert [c["text"] for c in comments] == [
        "note 2",
        "note 1",
        "note 0",
        "Shipped it.",
        "Looks good.",
    ]
    pages = await airtable_account.run.params("GET", COMMENTS)
    assert len(pages) == 2
    assert "offset" not in pages[0] and pages[1]["offset"]


@pytest.mark.asyncio
async def test_create_comment_posts_only_the_text(airtable_account):
    made = await create_comment(
        airtable_account.accessor(), ROADMAP, FEATURES, FIRST, "hello"
    )
    assert made["text"] == "hello"
    assert made["author"]["email"] == "ada@example.com"
    assert (await airtable_account.writes())[0][1] == {"text": "hello"}


@pytest.mark.asyncio
async def test_every_request_paces_under_its_base(
    airtable_account, monkeypatch
):
    accessor = airtable_account.accessor()
    keys: list[str] = []
    acquire = accessor.limiter.acquire

    async def _spy(key: str) -> None:
        keys.append(key)
        await acquire(key)

    monkeypatch.setattr(accessor.limiter, "acquire", _spy)
    await _drain(create_records(accessor, ROADMAP, FEATURES, _names(11)))
    await _drain(
        update_records(accessor, ROADMAP, FEATURES, [(FIRST, {"Priority": 2})])
    )
    await _drain(delete_records(accessor, ROADMAP, FEATURES, [FIRST]))
    await get_record(accessor, ROADMAP, FEATURES, "rec00000000000002")
    await create_comment(accessor, ROADMAP, FEATURES, "rec00000000000002", "x")
    await list_comments(accessor, ROADMAP, FEATURES, "rec00000000000002")
    assert keys == [ROADMAP] * 7
