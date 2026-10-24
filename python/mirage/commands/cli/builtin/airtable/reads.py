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

import functools

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.cli.builtin.airtable.util import (
    Outcome,
    find_table,
    no_operands,
    one_operand,
    run,
    scoped_base,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.airtable.client import (
    get_record,
    list_bases,
    list_comments,
    list_records,
    list_tables,
)
from mirage.core.airtable.normalize import (
    normalize_base,
    normalize_base_summary,
    normalize_comment,
    normalize_table,
    records_jsonl,
    to_json_bytes,
)
from mirage.io.types import IOResult


async def _base_list(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    no_operands(texts)
    bases = await list_bases(accessor)
    payload = [normalize_base_summary(base) for base in bases]
    return to_json_bytes(payload), IOResult()


async def _base_get(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    base_id = scoped_base(accessor.config, one_operand(texts, "BASE"))
    for base in await list_bases(accessor):
        if base.get("id") == base_id:
            tables = await list_tables(accessor, base_id)
            data = to_json_bytes(normalize_base(base, tables))
            return data, IOResult()
    raise LookupError(f"{base_id}: no such base")


async def _table_get(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    ref = one_operand(texts, "TABLE")
    base_id = scoped_base(accessor.config, fl.as_str("base") or "")
    table = find_table(await list_tables(accessor, base_id), ref)
    if table is None:
        raise LookupError(f"{ref}: no such table in {base_id}")
    return to_json_bytes(normalize_table(table, base_id)), IOResult()


async def _record_list(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    no_operands(texts)
    asked = fl.as_int("max_records")
    if asked is not None and asked < 1:
        raise UsageError("--max-records must be at least 1")
    base_id = scoped_base(accessor.config, fl.as_str("base") or "")
    cap = accessor.config.max_read_records
    records = await list_records(
        accessor,
        base_id,
        fl.as_str("table") or "",
        view=fl.as_str("view"),
        formula=fl.as_str("formula"),
        max_records=cap + 1 if asked is None else asked,
    )
    if asked is None and len(records) > cap:
        raise ValueError(
            f"more than {cap} records match (max_read_records);"
            " narrow them with --formula or --view, or take the"
            " first N with --max-records N"
        )
    return records_jsonl(records), IOResult()


async def _record_get(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    record_id = one_operand(texts, "RECORD")
    base_id = scoped_base(accessor.config, fl.as_str("base") or "")
    record = await get_record(
        accessor, base_id, fl.as_str("table") or "", record_id
    )
    return records_jsonl([record]), IOResult()


async def _comment_list(
    accessor: AirtableAccessor,
    texts: list[str],
    ctx: Context,
    fl: FlagView,
) -> Outcome:
    record_id = one_operand(texts, "RECORD")
    base_id = scoped_base(accessor.config, fl.as_str("base") or "")
    comments = await list_comments(
        accessor, base_id, fl.as_str("table") or "", record_id
    )
    payload = [normalize_comment(comment) for comment in comments]
    return to_json_bytes(payload), IOResult()


base_list = functools.partial(run, _base_list)
base_get = functools.partial(run, _base_get)
table_get = functools.partial(run, _table_get)
record_list = functools.partial(run, _record_list)
record_get = functools.partial(run, _record_get)
comment_list = functools.partial(run, _comment_list)
