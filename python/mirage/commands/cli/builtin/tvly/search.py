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

# `tvly search` adapted from tvly 1.0.2's src/commands/search.ts,
# src/core/search-flags.ts and src/ui/render/search.ts; the flags are
# @tavily/core 1.1.0's search parameter catalog, in the order tvly lists
# them (MIT; see licenses/third_party/tavily-cli.txt).

import asyncio
from dataclasses import dataclass
from typing import Literal

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.failure import (
    API_EXIT,
    AUTH_EXIT,
    LIMIT_STATUSES,
    keyless_cap_error,
    keyless_cap_hit,
    usage,
)
from mirage.commands.cli.builtin.tvly.options import (
    InvalidOption,
    check_choice,
    client_name_of,
    parse_number,
)
from mirage.commands.cli.builtin.tvly.output import (
    Streams,
    emit,
    resolve_output,
)
from mirage.commands.cli.builtin.tvly.render import (
    field,
    items,
    js_text,
    js_trim,
    json_text,
    plain,
    snippet,
    truthy,
    utf16_slice,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.tavily.client import (
    TavilyAPIError,
    TavilyKeylessLimit,
    TavilyUnanswered,
    tavily_request,
)
from mirage.core.tavily.constants import SEARCH_TIMEOUT
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import JsonValue, PathSpec

MAX_QUERIES = 5
DEFAULT_CHARS = 600
MAX_STDIN_CHARS = 100_000
QUERY_REQUIRED = (
    "error: QUERY is required. Pass a query string or use '-' to read "
    "from stdin."
)
MAX_CHARS_FLAGS = "--max-chars <n>"

Kind = Literal["value", "switch", "optional", "list", "integer", "number"]


@dataclass(frozen=True)
class SearchFlag:
    """One search option, from the SDK's parameter catalog.

    Args:
        key (str): the API field it sets.
        flag (str): its long spelling.
        kind (Kind): how its value is read.
        help (str): the catalog's description.
        choices (tuple[str, ...]): what a value may be.
        minimum (int | None): the smallest number it may be.
        maximum (int | None): the largest number it may be.
        bare (str | None): what an optional value reads as when bare.
    """

    key: str
    flag: str
    kind: Kind
    help: str
    choices: tuple[str, ...] = ()
    minimum: int | None = None
    maximum: int | None = None
    bare: str | None = None

    @property
    def dest(self) -> str:
        return self.flag[2:].replace("-", "_")

    @property
    def flags(self) -> str:
        """The option as commander's help and refusals spell it."""
        if self.kind == "switch":
            return self.flag
        if self.kind == "optional":
            return f"{self.flag} [value]"
        placeholder = {"list": "<list>", "integer": "<n>", "number": "<n>"}
        return f"{self.flag} {placeholder.get(self.kind, '<value>')}"


SEARCH_FLAGS = (
    SearchFlag(
        "search_depth",
        "--depth",
        "value",
        "Search strategy: basic for quick retrieval, advanced for deeper "
        "coverage, fast for lower latency, or ultra-fast for the lowest "
        "latency.",
        choices=("basic", "advanced", "fast", "ultra-fast"),
    ),
    SearchFlag(
        "max_results",
        "--max-results",
        "integer",
        "Result count limit.",
        minimum=0,
        maximum=20,
    ),
    SearchFlag(
        "topic",
        "--topic",
        "value",
        "Search category.",
        choices=("general", "news", "finance"),
    ),
    SearchFlag(
        "time_range",
        "--time-range",
        "value",
        "Relative date window; single-letter aliases are accepted.",
        choices=("year", "month", "week", "day", "y", "m", "w", "d"),
    ),
    SearchFlag(
        "start_date",
        "--start-date",
        "value",
        "Start of the date window (YYYY-MM-DD).",
    ),
    SearchFlag(
        "end_date",
        "--end-date",
        "value",
        "End of the date window (YYYY-MM-DD).",
    ),
    SearchFlag(
        "include_domains",
        "--include-domains",
        "list",
        "Domains to include or prefer.",
    ),
    SearchFlag(
        "exclude_domains", "--exclude-domains", "list", "Domains to omit."
    ),
    SearchFlag(
        "country", "--country", "value", "Country preference for results."
    ),
    SearchFlag(
        "include_answer",
        "--include-answer",
        "optional",
        "Request a generated answer; true selects the basic answer mode.",
        choices=("basic", "advanced", "false", "true"),
        bare="basic",
    ),
    SearchFlag(
        "include_raw_content",
        "--include-raw-content",
        "optional",
        "Return page content in the selected format, or disable it with "
        "false.",
        choices=("markdown", "text", "false"),
        bare="markdown",
    ),
    SearchFlag(
        "include_images",
        "--include-images",
        "switch",
        "Request images alongside text results.",
    ),
    SearchFlag(
        "include_image_descriptions",
        "--include-image-descriptions",
        "switch",
        "Request descriptions for returned images.",
    ),
    SearchFlag(
        "chunks_per_source",
        "--chunks-per-source",
        "integer",
        "Content chunks per source for advanced search.",
        minimum=1,
        maximum=3,
    ),
    SearchFlag(
        "auto_parameters",
        "--auto-parameters",
        "switch",
        "Let Tavily choose search settings from the query.",
    ),
    SearchFlag(
        "cache_fallback",
        "--cache-fallback",
        "switch",
        "Allow cached content when live fetching fails.",
    ),
    SearchFlag(
        "days", "--days", "number", "Lookback in days for news searches."
    ),
    SearchFlag(
        "exact_match",
        "--exact-match",
        "switch",
        "Require exact matches for quoted phrases in the query.",
    ),
    SearchFlag(
        "fetch_timeout",
        "--fetch-timeout",
        "number",
        "Live-fetch time budget in seconds.",
    ),
    SearchFlag(
        "filter_by_language",
        "--filter-by-language",
        "switch",
        "Restrict results to the requested language.",
    ),
    SearchFlag(
        "filter_by_published_date",
        "--filter-by-published-date",
        "switch",
        "Exclude undated results and results outside the requested date "
        "window; also enables publication dates.",
    ),
    SearchFlag(
        "include_domains_mode",
        "--include-domains-mode",
        "value",
        "How to apply includeDomains.",
        choices=("restrict", "prefer"),
    ),
    SearchFlag(
        "include_favicon", "--include-favicon", "switch", "Request site icons."
    ),
    SearchFlag(
        "include_published_date",
        "--include-published-date",
        "switch",
        "Request detected publication dates.",
    ),
    SearchFlag(
        "include_usage",
        "--include-usage",
        "switch",
        "Request credit usage details.",
    ),
    SearchFlag(
        "language", "--language", "value", "Preferred content language."
    ),
    SearchFlag(
        "max_age_hours",
        "--max-age-hours",
        "number",
        "Maximum acceptable cache age in hours.",
    ),
    SearchFlag(
        "safe_search",
        "--safe-search",
        "switch",
        "Filter explicit content from results.",
    ),
)

# The SDK catalog's own key order, which is the order tvly fills the
# request body in; the flags above are listed in its help order.
BODY_ORDER = (
    "search_depth",
    "topic",
    "days",
    "max_results",
    "include_images",
    "include_image_descriptions",
    "include_answer",
    "include_raw_content",
    "include_domains",
    "exclude_domains",
    "include_domains_mode",
    "time_range",
    "chunks_per_source",
    "country",
    "start_date",
    "end_date",
    "max_age_hours",
    "auto_parameters",
    "include_favicon",
    "include_usage",
    "exact_match",
    "fetch_timeout",
    "cache_fallback",
    "language",
    "filter_by_language",
    "safe_search",
    "include_published_date",
    "filter_by_published_date",
)


def flag_value(flag: SearchFlag, raw: str | bool) -> JsonValue:
    """One typed value of a search option, as the request carries it.

    Args:
        flag (SearchFlag): the option.
        raw (str | bool): what the line gave; True for a bare one.

    Raises:
        InvalidOption: the value is refused.
    """
    if flag.kind == "switch":
        return True
    if flag.kind == "optional":
        text = flag.bare if raw is True or raw == "" else str(raw)
        value = check_choice(str(text), flag.flags, flag.choices)
        return {"true": True, "false": False}.get(value, value)
    text = str(raw)
    if flag.kind == "list":
        return [part for part in (p.strip() for p in text.split(",")) if part]
    if flag.kind in ("integer", "number"):
        return parse_number(
            text,
            flag.flags,
            integer=flag.kind == "integer",
            minimum=flag.minimum,
            maximum=flag.maximum,
        )
    if flag.choices:
        return check_choice(text, flag.flags, flag.choices)
    return text


def search_body(fl: FlagView) -> dict[str, JsonValue]:
    """The request fields the line's search options set.

    Args:
        fl (FlagView): the line's flags.

    Raises:
        InvalidOption: a value is refused.
    """
    values: dict[str, JsonValue] = {}
    by_dest = {flag.dest: flag for flag in SEARCH_FLAGS}
    for dest, raw in fl.occurrences(*by_dest):
        flag = by_dest[dest]
        if isinstance(raw, (str, bool)):
            values[flag.key] = flag_value(flag, raw)
    body: dict[str, JsonValue] = {}
    for key in BODY_ORDER:
        value = values.get(key)
        if value is None or value == []:
            continue
        body[key] = value
    return body


async def read_queries(
    texts: list[str], ctx: Context
) -> list[str] | tuple[None, IOResult]:
    """The queries a line asks, or tvly's refusal of them.

    Args:
        texts (list[str]): the line's query operands.
        ctx (Context): the invocation context, for a ``-`` query.
    """
    if texts == ["-"]:
        piped = (await materialize(ctx.stdin)).decode("utf-8", "replace")
        query = js_trim(utf16_slice(piped, MAX_STDIN_CHARS))
        queries = [query] if query else []
    else:
        queries = [query for query in texts if js_trim(query)]
    if not queries:
        return usage(QUERY_REQUIRED)
    if len(queries) > MAX_QUERIES:
        return usage(
            f"error: At most {MAX_QUERIES} queries per command, got "
            f"{len(queries)}."
        )
    return queries


def image_url(image: JsonValue) -> JsonValue:
    if isinstance(image, (dict, list)):
        url = field(image, "url")
        return url if url is not None else json_text(image, False)
    return image


def results_text(streams: Streams, data: JsonValue, max_chars: int) -> None:
    """One search's answer as tvly prints it to a pipe.

    Args:
        streams (Streams): where the verb's output gathers.
        data (JsonValue): the API's answer.
        max_chars (int): content characters per result; 0 for all.
    """
    results = items(field(data, "results"))
    answer = field(data, "answer")
    if truthy(answer):
        streams.out(f"Answer: {plain(answer)}\n")
    for index, result in enumerate(results):
        title = field(result, "title")
        streams.out(
            f"{index + 1}. {plain(title if truthy(title) else 'Untitled')}"
        )
        url = field(result, "url")
        streams.out(plain("" if url is None else url))
        content = field(result, "content")
        if truthy(content):
            streams.out(snippet(content, max_chars))
        streams.out()
    if not results:
        streams.out("No results found.")
    for image in items(field(data, "images")):
        streams.out(f"Image: {plain(image_url(image))}")


async def search(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Search the web; up to five queries run in parallel.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): the queries.
        ctx (Context): the invocation context.
    """
    fl = FlagView(ctx.flags, ctx.spec)
    json = fl.as_bool("json")
    try:
        body = search_body(fl)
        max_chars = None
        for _, raw in fl.texts("max_chars"):
            max_chars = parse_number(
                raw, MAX_CHARS_FLAGS, integer=True, minimum=0
            )
    except InvalidOption as refused:
        return usage(str(refused))
    asked = await read_queries(texts, ctx)
    if isinstance(asked, tuple):
        return asked
    queries = asked
    output = resolve_output(fl, ctx, "search", queries[0])
    chars = (
        int(max_chars)
        if max_chars is not None
        else DEFAULT_CHARS // len(queries)
    )
    client_name = client_name_of(fl)
    streams = Streams()

    async def one(query: str) -> JsonValue:
        answer: JsonValue = await tavily_request(
            accessor,
            "POST",
            "search",
            {"query": query, **body},
            timeout=SEARCH_TIMEOUT,
            client_name=client_name,
        )
        return answer

    if len(queries) == 1:
        data = await one(queries[0])
        if json or output is not None:
            await emit(streams, ctx, json_text(data, True), output)
            if json:
                return streams.result()
        results_text(streams, data, chars)
        return streams.result()

    caps: list[TavilyKeylessLimit] = []
    limited = False

    async def guarded_one(query: str) -> JsonValue:
        nonlocal limited
        try:
            return await one(query)
        except TavilyKeylessLimit as cap:
            caps.append(cap)
            return {"query": query, "error": keyless_cap_error(cap)}
        except (TavilyAPIError, TavilyUnanswered) as failed:
            if isinstance(failed, TavilyAPIError):
                limited = limited or failed.status in LIMIT_STATUSES
            return {"query": query, "error": str(failed)}

    responses = list(await asyncio.gather(*(guarded_one(q) for q in queries)))
    if caps and not json:
        keyless_cap_hit(streams, caps[0])
        return streams.result(AUTH_EXIT)
    if json or output is not None:
        await emit(streams, ctx, json_text(responses, True), output)
    if not json:
        for index, response in enumerate(responses):
            query = field(response, "query")
            streams.out(
                f"=== [{index + 1}/{len(responses)}] "
                f"{plain('' if query is None else query)}"
            )
            if isinstance(response, dict) and "error" in response:
                error = response["error"]
                text = (
                    field(error, "message")
                    if isinstance(error, dict)
                    else error
                )
                streams.out(f"error: {plain(js_text(text))}\n")
            else:
                results_text(streams, response, chars)
    failed_all = all(isinstance(r, dict) and "error" in r for r in responses)
    if failed_all:
        return streams.result(AUTH_EXIT if caps or limited else API_EXIT)
    return streams.result()
