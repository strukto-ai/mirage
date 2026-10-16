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

from collections.abc import AsyncGenerator, AsyncIterator, Mapping, Sequence
from contextlib import aclosing
from dataclasses import replace
from functools import partial
from typing import Any, TypeVar
from urllib.parse import quote, urlencode

import aiohttp

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.constants import (
    MAX_BATCH,
    META_KEY,
    PAGE_SIZE,
    WEBHOOK_PAGE_SIZE,
)
from mirage.core.airtable.errors import AirtableAPIError, error_parts
from mirage.core.airtable.normalize import as_row, as_rows
from mirage.core.api.client import RetryPolicy, api_request
from mirage.core.api.paginate import (
    PageShape,
    cursor_items,
    cursor_pages,
    offset_cursor,
)
from mirage.vfs.secrets import reveal_secret

BASES = PageShape(items_key="bases", next_cursor=offset_cursor)
RECORDS = PageShape(items_key="records", next_cursor=offset_cursor)
COMMENTS = PageShape(items_key="comments", next_cursor=offset_cursor)

T = TypeVar("T")


def _error_of(
    resp: aiohttp.ClientResponse, text: str, *, call: str
) -> Exception:
    kind, message = error_parts(text)
    detail = ": ".join(part for part in (kind, message) if part)
    return AirtableAPIError(
        f"Airtable API error ({call}): HTTP {resp.status}"
        f"{': ' + detail if detail else ''}",
        status=resp.status,
        error_type=kind,
    )


def _retryable(status: int, text: str) -> bool:
    # A 429 means either "slow down" (RATE_LIMIT_REACHED) or "this
    # workspace spent its monthly calls"; waiting only helps the first.
    kind, _ = error_parts(text)
    return kind != "PUBLIC_API_BILLING_LIMIT_EXCEEDED"


# After a 429 Airtable refuses every request to the base for 30 seconds,
# so a retry sooner than that is spent inside the penalty; 502 and 503
# are documented as safe to retry with backoff.
RETRY = RetryPolicy(
    statuses=frozenset({429, 502, 503}),
    max_retries=2,
    max_backoff=30.0,
    retryable=_retryable,
    min_delays={429: 30.0},
)

# A write retries only the 429, which Airtable answers before it applies
# anything. A 502 or 503 may come back after the records landed, and a
# retried create would make them twice.
WRITE_RETRY = replace(RETRY, statuses=frozenset({429}))


def _headers(accessor: AirtableAccessor) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(accessor.config.token)}",
    }


async def _request(
    accessor: AirtableAccessor,
    method: str,
    path: str,
    *,
    pace_key: str,
    params: Mapping[str, str | int] | None = None,
    query: str = "",
    json_body: dict[str, Any] | None = None,
    retry: RetryPolicy = RETRY,
) -> Any:
    await accessor.limiter.acquire(pace_key)
    url = f"{accessor.config.base_url}{path}"
    return await api_request(
        method,
        f"{url}?{query}" if query else url,
        error_of=partial(_error_of, call=f"{method} {path}"),
        headers=_headers(accessor),
        params=params,
        json_body=json_body,
        retry=retry,
        session=accessor.pool,
    )


async def _get(
    accessor: AirtableAccessor,
    path: str,
    *,
    params: Mapping[str, str | int] | None,
    pace_key: str,
) -> Any:
    return await _request(
        accessor, "GET", path, pace_key=pace_key, params=params
    )


def _segment(value: str) -> str:
    return quote(value, safe="")


def _table_path(base_id: str, table: str) -> str:
    return f"/{_segment(base_id)}/{_segment(table)}"


def _record_path(base_id: str, table: str, record_id: str) -> str:
    return f"{_table_path(base_id, table)}/{_segment(record_id)}"


def _batches(items: Sequence[T]) -> list[Sequence[T]]:
    return [
        items[start : start + MAX_BATCH]
        for start in range(0, len(items), MAX_BATCH)
    ]


async def _page(
    accessor: AirtableAccessor,
    pace_key: str,
    path: str,
    params: dict[str, str | int],
    cursor: str | None,
) -> dict[str, Any]:
    query = {**params, "offset": cursor} if cursor else params
    return as_row(await _get(accessor, path, params=query, pace_key=pace_key))


async def list_bases(accessor: AirtableAccessor) -> list[dict[str, Any]]:
    """Every base the token reaches, narrowed to ``config.base_ids``.

    Args:
        accessor (AirtableAccessor): the account.
    """
    bases = await cursor_items(
        partial(_page, accessor, META_KEY, "/meta/bases", {}), shape=BASES
    )
    wanted = accessor.config.base_ids
    return [
        base
        for base in as_rows(bases)
        if wanted is None or base.get("id") in wanted
    ]


async def list_tables(
    accessor: AirtableAccessor, base_id: str
) -> list[dict[str, Any]]:
    """A base's schema: its tables with their fields and views.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
    """
    data = await _get(
        accessor,
        f"/meta/bases/{_segment(base_id)}/tables",
        params=None,
        pace_key=base_id,
    )
    return as_rows(as_row(data).get("tables"))


async def list_webhooks(
    accessor: AirtableAccessor, base_id: str
) -> list[dict[str, Any]]:
    """A base's webhooks, each with ``cursorForNextPayload``.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
    """
    data = await _get(
        accessor,
        f"/bases/{_segment(base_id)}/webhooks",
        params=None,
        pace_key=base_id,
    )
    return as_rows(as_row(data).get("webhooks"))


async def webhook_payloads(
    accessor: AirtableAccessor,
    base_id: str,
    webhook_id: str,
    cursor: int | None,
) -> dict[str, Any]:
    """One page of a webhook's payloads from ``cursor``: ``payloads``,
    the ``cursor`` after them, and ``mightHaveMore``.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        webhook_id (str): the webhook.
        cursor (int | None): the first payload's number, None for the
            oldest Airtable still keeps.
    """
    params: dict[str, str | int] = {"limit": WEBHOOK_PAGE_SIZE}
    if cursor is not None:
        params["cursor"] = cursor
    path = f"/bases/{_segment(base_id)}/webhooks/{_segment(webhook_id)}"
    return as_row(
        await _get(
            accessor, f"{path}/payloads", params=params, pace_key=base_id
        )
    )


async def list_records(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    *,
    view: str | None = None,
    formula: str | None = None,
    max_records: int | None = None,
) -> list[dict[str, Any]]:
    """A table's records in the API's order, or a view's.

    Without a view Airtable calls the order arbitrary; it is the order
    the table hands out, stable between calls, and the only one a
    ``maxRecords`` prefix agrees with.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        view (str | None): a view, by id or by name; its filter and
            order apply.
        formula (str | None): an Airtable formula (``filterByFormula``);
            only the records it is true for are listed.
        max_records (int | None): stop after this many records, both on
            the wire (``maxRecords``) and in the collector.
    """
    records = await cursor_items(
        partial(
            _page,
            accessor,
            base_id,
            _table_path(base_id, table_id),
            _record_params(view, formula, max_records),
        ),
        max_results=max_records,
        shape=RECORDS,
    )
    return as_rows(records)


async def record_pages(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    *,
    view: str | None = None,
    max_records: int | None = None,
) -> AsyncGenerator[list[dict[str, Any]], None]:
    """A table's records as :func:`list_records` lists them, one page at
    a time, the next page fetched only when the caller pulls it.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        view (str | None): a view, by id or by name; its filter and
            order apply.
        max_records (int | None): stop after this many records on the
            wire (``maxRecords``).
    """
    pages = cursor_pages(
        partial(
            _page,
            accessor,
            base_id,
            _table_path(base_id, table_id),
            _record_params(view, None, max_records),
        ),
        shape=RECORDS,
    )
    async with aclosing(pages):
        async for page in pages:
            yield as_rows(page)


def _record_params(
    view: str | None, formula: str | None, max_records: int | None
) -> dict[str, str | int]:
    params: dict[str, str | int] = {"pageSize": PAGE_SIZE}
    if view is not None:
        params["view"] = view
    if formula is not None:
        params["filterByFormula"] = formula
    if max_records is not None:
        params["maxRecords"] = max_records
    return params


async def get_record(
    accessor: AirtableAccessor, base_id: str, table_id: str, record_id: str
) -> dict[str, Any]:
    """One record by id.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
    """
    data = await _get(
        accessor,
        _record_path(base_id, table_id, record_id),
        params=None,
        pace_key=base_id,
    )
    return as_row(data)


async def _write(
    accessor: AirtableAccessor,
    method: str,
    base_id: str,
    table_id: str,
    rows: Sequence[dict[str, Any]],
    typecast: bool,
) -> AsyncIterator[list[dict[str, Any]]]:
    path = _table_path(base_id, table_id)
    for batch in _batches(rows):
        body: dict[str, Any] = {"records": list(batch)}
        if typecast:
            body["typecast"] = True
        data = await _request(
            accessor,
            method,
            path,
            pace_key=base_id,
            json_body=body,
            retry=WRITE_RETRY,
        )
        yield as_rows(as_row(data).get("records"))


def create_records(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    records: Sequence[dict[str, Any]],
    *,
    typecast: bool = False,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Create records ten to a request, yielding each request's records.

    A request that fails raises after every earlier one landed, so the
    caller holds exactly what was written.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        records (Sequence[dict[str, Any]]): each new record's cell map,
            keyed by field name.
        typecast (bool): let Airtable convert string values to the
            field types (``typecast``).
    """
    return _write(
        accessor,
        "POST",
        base_id,
        table_id,
        [{"fields": fields} for fields in records],
        typecast,
    )


def update_records(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    updates: Sequence[tuple[str, dict[str, Any]]],
    *,
    typecast: bool = False,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Patch records ten to a request, yielding each request's records.

    A PATCH, never a PUT: a cell the update leaves out keeps its value.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        updates (Sequence[tuple[str, dict[str, Any]]]): record id and the
            cells to change, keyed by field name.
        typecast (bool): let Airtable convert string values to the
            field types (``typecast``).
    """
    return _write(
        accessor,
        "PATCH",
        base_id,
        table_id,
        [{"id": record_id, "fields": fields} for record_id, fields in updates],
        typecast,
    )


async def delete_records(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    record_ids: Sequence[str],
) -> AsyncIterator[list[dict[str, Any]]]:
    """Delete records ten to a request, yielding each request's answer.

    The ids ride the query string as ``records[]``, which is the only
    place the endpoint reads them from.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_ids (Sequence[str]): the records to delete.
    """
    path = _table_path(base_id, table_id)
    for batch in _batches(record_ids):
        data = await _request(
            accessor,
            "DELETE",
            path,
            pace_key=base_id,
            query=urlencode([("records[]", record_id) for record_id in batch]),
            retry=WRITE_RETRY,
        )
        yield as_rows(as_row(data).get("records"))


async def list_comments(
    accessor: AirtableAccessor, base_id: str, table_id: str, record_id: str
) -> list[dict[str, Any]]:
    """A record's comments in the API's order, newest first.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
    """
    path = f"{_record_path(base_id, table_id, record_id)}/comments"
    comments = await cursor_items(
        partial(_page, accessor, base_id, path, {"pageSize": PAGE_SIZE}),
        shape=COMMENTS,
    )
    return as_rows(comments)


async def create_comment(
    accessor: AirtableAccessor,
    base_id: str,
    table_id: str,
    record_id: str,
    text: str,
) -> dict[str, Any]:
    """Comment on a record as the token's user.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
        text (str): the comment text.
    """
    data = await _request(
        accessor,
        "POST",
        f"{_record_path(base_id, table_id, record_id)}/comments",
        pace_key=base_id,
        json_body={"text": text},
        retry=WRITE_RETRY,
    )
    return as_row(data)
