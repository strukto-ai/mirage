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

import logging

import aiohttp

from mirage.accessor.airtable import AirtableAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.airtable.client import list_records
from mirage.core.airtable.errors import AirtableAPIError
from mirage.core.airtable.normalize import records_jsonl
from mirage.core.airtable.readdir import readdir, schema_table
from mirage.core.airtable.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.types import PathSpec
from mirage.utils.record_search import record_queries

logger = logging.getLogger(__name__)

# A line's keys besides its field names, and the JSON literals.
LINE_KEYS = frozenset(
    {"record_id", "created_time", "fields", "true", "false", "null"}
)

# Cell types a line spells as the text a formula reads of them: a string,
# or strings in a list a formula joins with ", ".
TEXT_TYPES = frozenset(
    {
        "singleLineText",
        "multilineText",
        "richText",
        "email",
        "url",
        "phoneNumber",
        "singleSelect",
        "multipleSelects",
    }
)

# Cell types a line spells with digits, ``- . : + e T Z`` or ``true``
# only, where no text of three letters lies outside a key.
WORDLESS_TYPES = frozenset(
    {
        "number",
        "percent",
        "currency",
        "duration",
        "rating",
        "autoNumber",
        "count",
        "checkbox",
        "date",
        "dateTime",
        "createdTime",
        "lastModifiedTime",
    }
)

# Cell types whose JSON holds no space outside the text a formula reads
# of them: a link's record ids, an AI text's state and error type around
# its value, an attachment's ids, urls and type around its file name.
# A text with a space is found in the formula's text or nowhere.
SPACELESS_TYPES = frozenset({"multipleRecordLinks"})
SPACED_TEXT_TYPES = frozenset({"aiText", "multipleAttachments"})


async def lines_containing(
    accessor: AirtableAccessor,
    path: PathSpec,
    text: str,
    index: IndexCacheStore,
) -> bytes | None:
    """The lines of a table's records.jsonl or a view's file that may hold
    ``text``, in the order a plain read lists them.

    Airtable lists only the records a formula is true for, so the formula
    asks whether the record id (``RECORD_ID()``) or a cell, as the text a
    formula reads and lowercased, holds ``text``; grep matches each line
    itself. Only a table whose every field spells its cell as that text (a
    text, a select, an email, a url, a phone number) or with no word in it
    (a number, a date, a checkbox) is asked; a link, an AI text or an
    attachment holds no space outside the text a formula reads of it, so
    a table with one is asked for a text with a space. A collaborator, a
    lookup or a formula renders ids or errors a formula does not read.
    ``text`` goes through ``record_queries`` for the
    line's keys, field names among them, and its escapes. None for any
    other file, a path the listing does not hold, a table with another
    field type or a field name a formula cannot quote, a text a key holds,
    a failed listing, or more than ``max_read_records`` matches.

    Args:
        accessor (AirtableAccessor): the account.
        path (PathSpec): the file grep would read.
        text (str): plain text every match holds.
        index (IndexCacheStore): the listings that prove the path.
    """
    match = detect_scope(path)
    if match.kind not in ("records", "view"):
        return None
    if index is NULL_INDEX or index is None:
        index = RAMIndexCacheStore()
    try:
        if await resolve_entry(readdir, accessor, path, index) is None:
            return None
        table = await schema_table(accessor, match)
    except FileNotFoundError:
        return None
    fields = [
        field for field in table.get("fields", []) if isinstance(field, dict)
    ]
    keys = LINE_KEYS | {str(field.get("name", "")).lower() for field in fields}
    queries = record_queries(text, keys, whole_word=False)
    if queries is None:
        return None
    asked = [query.lower() for query in queries]
    if any(query in key for query in asked for key in keys):
        return None
    spaced = all(" " in query for query in asked)
    cells = ["LOWER(RECORD_ID())"]
    for field in fields:
        name = str(field.get("name", ""))
        kind = field.get("type")
        if {"{", "}"} & set(name):
            return None
        if kind in TEXT_TYPES or spaced and kind in SPACED_TEXT_TYPES:
            cells.append(f'LOWER({{{name}}} & "")')
        elif not (
            kind in WORDLESS_TYPES or spaced and kind in SPACELESS_TYPES
        ):
            return None
    formula = "OR({})".format(
        ", ".join(
            f'SEARCH("{query}", {cell})' for query in asked for cell in cells
        )
    )
    cap = accessor.config.max_read_records
    try:
        records = await list_records(
            accessor,
            match.slots["base_id"],
            match.slots["table_id"],
            view=match.slots.get("view_id"),
            formula=formula,
            max_records=cap + 1,
        )
    except (AirtableAPIError, aiohttp.ClientError, OSError) as exc:
        logger.debug("airtable search failed (%s); reading the file", exc)
        return None
    if len(records) > cap:
        return None
    return records_jsonl(records)
