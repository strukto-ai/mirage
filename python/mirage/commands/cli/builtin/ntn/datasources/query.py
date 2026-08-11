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

from typing import Any

from mirage.commands.cli.builtin.ntn.failure import HintedAPIError, source_hint
from mirage.commands.cli.builtin.ntn.util import (first_text, notion_config,
                                                  parse_json_text, pretty_json,
                                                  property_cell)
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.notion._client import NotionAPIError
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.pages import (get_data_source, get_database,
                                      query_data_source_page)
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

DEFAULT_LIMIT = 25
DIRECTIONS = {
    "asc": "ascending",
    "ascending": "ascending",
    "desc": "descending",
    "descending": "descending",
}


def data_source_ref(operand: str) -> str:
    """Reduce a data source operand to its bare id.

    Args:
        operand (str): a data source id, database id, or Notion URL.

    Returns:
        str: the trailing id-shaped token.
    """
    tail = operand.rsplit("/", 1)[-1]
    return tail.split("?", 1)[0]


def parse_sort(spec: str) -> dict[str, JsonValue]:
    """Parse one `-s '<property> [asc|desc]'` operand.

    Args:
        spec (str): the flag value.

    Returns:
        dict: a Notion sort object.
    """
    head, _, tail = spec.rpartition(" ")
    if head and tail.lower() in DIRECTIONS:
        return {"property": head, "direction": DIRECTIONS[tail.lower()]}
    return {"property": spec, "direction": "ascending"}


async def resolve_source(config: NotionConfig, ref: str) -> dict[str, Any]:
    """Fetch the data source an operand names, following a database.

    A database id is accepted in the same slot as a data source id, so
    a miss on the data source endpoint is not an error until the
    database endpoint misses too.

    Args:
        config (NotionConfig): notion API config.
        ref (str): the id to resolve.

    Returns:
        dict: the data source object.
    """
    try:
        return await get_data_source(config, ref)
    except NotionAPIError as miss:
        if miss.status != 404:
            raise
        first = miss
    # The database endpoint is a fallback, so its own 404 is not the
    # answer to report: upstream names the *data source* the operand
    # failed to be and adds one hint covering both, where reporting the
    # second miss would tell the user their data source id is not a
    # database id, which they never claimed it was.
    try:
        database = await get_database(config, ref)
    except NotionAPIError as second:
        if second.status != 404:
            raise
        raise HintedAPIError(first, source_hint(ref)) from second
    stubs = database.get("data_sources") or []
    if not stubs or not isinstance(stubs[0], dict):
        raise UsageError(f"database {ref} has no data sources")
    return await get_data_source(config, str(stubs[0].get("id", "")))


async def filter_body(fl: FlagView,
                      ops: CLIVerbOpts | None) -> dict[str, JsonValue]:
    """Read the query filter from `--filter` or `--filter-file`.

    Args:
        fl (FlagView): the leaf's parsed flags.
        ops (CLIVerbOpts | None): the workspace doors, used to read a
            filter file the user named, the way himalaya reads
            ``--attach``.

    Returns:
        dict: the filter object, empty when neither flag is present.
    """
    inline = fl.as_str("filter")
    if inline:
        return parse_json_text(inline, "--filter")
    sources = fl.as_paths("filter_file")
    if not sources:
        return {}
    if ops is None or ops.dispatch is None:
        raise UsageError("--filter-file needs a workspace to read files from")
    data, _ = await ops.dispatch("read", sources[0])
    raw = data if isinstance(data, bytes) else bytes(data)
    return parse_json_text(raw.decode("utf-8", "replace"), "--filter-file")


async def query(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    # The whole request body is built before the first call, so a bad
    # --filter refuses the line without having reached the API.
    ref = data_source_ref(first_text(inv.texts, "data source id"))
    body: dict[str, JsonValue] = {
        "page_size": fl.as_int("limit") or DEFAULT_LIMIT
    }
    cursor = fl.as_str("start_cursor")
    if cursor:
        body["start_cursor"] = cursor
    sorts: list[JsonValue] = [parse_sort(one) for one in fl.as_list("sort")]
    if sorts:
        body["sorts"] = sorts
    chosen = await filter_body(fl, inv.ops)
    if chosen:
        body["filter"] = chosen

    config = notion_config(inv)
    data_source = await resolve_source(config, ref)
    source_id = str(data_source.get("id", ""))
    result = await query_data_source_page(config, source_id, body)
    if fl.as_bool("json"):
        return yield_bytes(pretty_json(result)), IOResult()

    # Columns are the property names the returned rows actually carry, in
    # alphabetical order, not the data source's whole schema. Upstream
    # derives them from the page objects it got back, so a result set that
    # does not cover the schema prints narrower: a row created from Markdown
    # alone holds only its title column, and on its own it prints as
    # `<id>\t<title>` rather than as one title among seven blanks.
    rows = result.get("results") or []
    columns = sorted(
        {name
         for row in rows
         for name in (row.get("properties") or {})})
    lines: list[str] = []
    for row in rows:
        props = row.get("properties") or {}
        cells = [property_cell(props.get(name)) for name in columns]
        lines.append("\t".join([str(row.get("id", "")), *cells]) + "\n")
    out = yield_bytes("".join(lines).encode())
    if result.get("has_more") and result.get("next_cursor"):
        notice = ("\nMore results available. Use --start-cursor "
                  f"{result['next_cursor']} to continue.\n")
        return out, IOResult(stderr=notice.encode())
    return out, IOResult()
