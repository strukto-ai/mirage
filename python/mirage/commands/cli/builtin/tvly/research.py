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

# `tvly research` adapted from tvly 1.0.2's src/commands/research.ts,
# src/core/sse.ts and src/ui/render/research.ts (MIT; see
# licenses/third_party/tavily-cli.txt).

import asyncio
import json
from urllib.parse import quote

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.failure import require_key, usage
from mirage.commands.cli.builtin.tvly.options import (
    InvalidOption,
    client_name_of,
    typed_choice,
    typed_number,
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
    sanitize_control,
    truthy,
    utf16_slice,
)
from mirage.commands.cli.walk import node_help
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import UsageStyle
from mirage.core.tavily.client import TavilyUnanswered, tavily_request
from mirage.core.tavily.constants import RESEARCH_GET_TIMEOUT
from mirage.errors.constants import MISS_ERRORS
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import JsonValue, PathSpec
from mirage.utils.clock import system_now

SUBCOMMANDS = frozenset({"run", "status", "poll"})
NEED_ID = frozenset({"status", "poll"})
MODELS = ("mini", "pro", "auto")
CITATION_FORMATS = ("numbered", "mla", "apa", "chicago")
DEFAULT_POLL_INTERVAL = 10
DEFAULT_TIMEOUT = 600
MAX_STDIN_CHARS = 100_000
QUERY_REQUIRED = (
    "error: QUERY is required. Pass a query string or use '-' to read "
    "from stdin."
)
# What `research status` and `research poll` do not take, by dest and
# spelling: the line names them only on `run`.
RUN_ONLY = (
    ("model", "--model"),
    ("no_wait", "--no-wait"),
    ("stream", "--stream"),
    ("output_schema", "--output-schema"),
    ("citation_format", "--citation-format"),
)
STATUS_REFUSES = (
    *RUN_ONLY,
    ("output", "-o"),
    ("poll_interval", "--poll-interval"),
    ("timeout", "--timeout"),
)


def route(words: list[str]) -> tuple[str, list[str]]:
    """Which research verb a line means, and its operands.

    A first word that is no verb is a query for ``run``, and so is
    ``status`` or ``poll`` with no id after it; ``run`` always stays the
    verb, so ``run run`` researches the word "run".

    Args:
        words (list[str]): the words after ``research``.
    """
    first = words[0]
    if first not in SUBCOMMANDS:
        return "run", words
    if first in NEED_ID and len(words) < 2:
        return "run", words
    return first, words[1:]


def is_done(response: JsonValue) -> bool:
    return field(response, "status") in ("completed", "failed")


def too_many(verb: str, words: list[str]) -> tuple[None, IOResult]:
    return usage(
        f"error: too many arguments for '{verb}'. Expected 1 argument but "
        f"got {len(words)}: {', '.join(words)}."
    )


async def result_text(
    streams: Streams,
    ctx: Context,
    json_out: bool,
    data: JsonValue,
    output: PathSpec | None,
) -> None:
    """A finished task as tvly prints it to a pipe.

    Args:
        streams (Streams): where the verb's output gathers.
        ctx (Context): the invocation context.
        json_out (bool): whether the line asked for JSON.
        data (JsonValue): the task.
        output (PathSpec | None): the ``-o`` file.
    """
    if json_out or output is not None:
        await emit(streams, ctx, json_text(data, True), output)
        return
    status = field(data, "status")
    if status != "completed":
        streams.out(
            f"Status: {sanitize_control('unknown' if status is None else status)}"
        )
        error = field(data, "error")
        if truthy(error):
            streams.out(f"Error: {sanitize_control(error)}")
        return
    content = field(data, "content")
    if truthy(content):
        streams.out(f"{plain(content)}\n")
    sources = items(field(data, "sources"))
    if sources:
        streams.out("Sources:")
        for index, source in enumerate(sources):
            title = field(source, "title")
            url = field(source, "url")
            streams.out(
                f"{index + 1}. {plain('' if title is None else title)} "
                f"{plain('' if url is None else url)}"
            )


async def wait_for(
    accessor: TavilyAccessor,
    request_id: str,
    poll_interval: float,
    timeout: float,
    client_name: str | None,
) -> JsonValue:
    """Poll until the task completes or fails; None once ``timeout``
    seconds pass.

    Args:
        accessor (TavilyAccessor): the install's account.
        request_id (str): the task.
        poll_interval (float): seconds between polls, at least one.
        timeout (float): seconds to wait in all.
        client_name (str | None): sent as ``X-Client-Name``.
    """
    start = system_now()
    deadline = start + timeout
    next_poll = start
    while system_now() < deadline:
        if system_now() >= next_poll:
            response: JsonValue = await tavily_request(
                accessor,
                "GET",
                f"research/{quote(request_id, safe='')}",
                timeout=RESEARCH_GET_TIMEOUT,
                client_name=client_name,
            )
            if is_done(response):
                return response
            next_poll = system_now() + max(1.0, poll_interval)
        await asyncio.sleep(1)
    return None


async def finish_wait(
    streams: Streams,
    ctx: Context,
    fl: FlagView,
    response: JsonValue,
    request_id: str,
    output: PathSpec | None,
    timeout: float,
    hint: str = "",
) -> None:
    if response is not None:
        await result_text(streams, ctx, fl.as_bool("json"), response, output)
        return
    if fl.as_bool("json"):
        pending: dict[str, JsonValue] = {
            "request_id": request_id,
            "status": "timeout",
        }
        await emit(streams, ctx, json_text(pending, False), output)
        return
    streams.err(f"Timed out after {js_text(timeout)}s.{hint}")


def stream_events(text: str) -> list[JsonValue]:
    """The JSON payload of each SSE ``data:`` line; blank and non-JSON
    payloads (``[DONE]``) are skipped.

    Args:
        text (str): the whole event stream.
    """
    events: list[JsonValue] = []
    for raw in text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if not line.startswith("data:"):
            continue
        payload = line[5:]
        payload = payload[1:] if payload.startswith(" ") else payload
        if not js_trim(payload):
            continue
        try:
            events.append(json.loads(payload))
        except ValueError:
            continue
    return events


async def streamed(
    streams: Streams,
    ctx: Context,
    events: list[JsonValue],
    output: PathSpec | None,
) -> None:
    """Show each tool step on stderr as it changes, then the joined
    content as the report.

    Args:
        streams (Streams): where the verb's output gathers.
        ctx (Context): the invocation context.
        events (list[JsonValue]): the stream's events.
        output (PathSpec | None): the ``-o`` file.
    """
    parts: list[str] = []
    sources: JsonValue = []
    current: str | None = None
    for event in events:
        choices = items(field(event, "choices"))
        delta = field(choices[0], "delta") if choices else None
        tool_calls = field(delta, "tool_calls")
        kind = field(tool_calls, "type")
        if kind == "tool_call":
            for call in items(field(tool_calls, "tool_call")):
                name = js_text(field(call, "name") or "")
                arguments = field(call, "arguments")
                step = (
                    f"{name}: {js_text(arguments)}"
                    if truthy(arguments)
                    else name
                )
                if step != current:
                    current = step
                    streams.err(f"  {sanitize_control(step)}")
        if kind == "tool_response":
            for answer in items(field(tool_calls, "tool_response")):
                count = len(items(field(answer, "sources")))
                if field(answer, "name") == "WebSearch" and count:
                    streams.err(f"  Found {count} sources")
        content = field(delta, "content")
        if truthy(content):
            parts.append(js_text(content))
        found = items(field(delta, "sources"))
        if found:
            sources = found
    report: dict[str, JsonValue] = {
        "status": "completed",
        "content": "".join(parts),
        "sources": sources,
    }
    await result_text(streams, ctx, False, report, output)


async def run(
    accessor: TavilyAccessor,
    fl: FlagView,
    words: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if len(words) > 1:
        return too_many("run", words)
    query = words[0] if words else ""
    if query == "-":
        piped = (await materialize(ctx.stdin)).decode("utf-8", "replace")
        query = utf16_slice(piped, MAX_STDIN_CHARS)
    query = js_trim(query)
    if not query:
        return usage(QUERY_REQUIRED)
    output = resolve_output(fl, ctx, "research", query)
    body: dict[str, JsonValue] = {"input": query}
    model = typed_choice(fl, "model", "--model <model>", MODELS)
    if model is not None:
        body["model"] = model
    schema = fl.as_path("output_schema")
    if schema is not None:
        if ctx.vfs is None:
            raise RuntimeError("no workspace files")
        try:
            text = await ctx.vfs.read(schema)
        except MISS_ERRORS:
            return usage(
                "error: --output-schema must be a path to a JSON file: "
                "ENOENT: no such file or directory, open "
                f"'{schema.raw_path}'"
            )
        try:
            body["output_schema"] = json.loads(text)
        except ValueError as exc:
            return usage(
                f"error: --output-schema must be a path to a JSON file: {exc}"
            )
    citation = typed_choice(
        fl, "citation_format", "--citation-format <format>", CITATION_FORMATS
    )
    if citation is not None:
        body["citation_format"] = citation
    if accessor.config.api_key is None:
        return require_key("research")
    client_name = client_name_of(fl)
    streams = Streams()
    if fl.as_bool("stream"):
        text = await tavily_request(
            accessor,
            "POST",
            "research",
            {"citation_format": "numbered", **body, "stream": True},
            client_name=client_name,
            read="text",
        )
        events = stream_events(text)
        if fl.as_bool("json"):
            for event in events:
                streams.out(json_text(event, False))
            return streams.result()
        await streamed(streams, ctx, events, output)
        return streams.result()
    result = await tavily_request(
        accessor,
        "POST",
        "research",
        {"stream": False, "citation_format": "numbered", **body},
        client_name=client_name,
    )
    if is_done(result) or truthy(field(result, "content")):
        await result_text(streams, ctx, fl.as_bool("json"), result, output)
        return streams.result()
    request_id = field(result, "request_id")
    if not isinstance(request_id, str) or not request_id:
        raise TavilyUnanswered(
            f"Unexpected API response: {json_text(result, False)}"
        )
    if fl.as_bool("no_wait"):
        status = field(result, "status")
        waiting: dict[str, JsonValue] = {
            "request_id": request_id,
            "status": "pending" if status is None else status,
        }
        await emit(streams, ctx, json_text(waiting, False), output)
        return streams.result()
    timeout = typed_number(
        fl, "timeout", "--timeout <n>", integer=True, default=DEFAULT_TIMEOUT
    )
    interval = typed_number(
        fl,
        "poll_interval",
        "--poll-interval <n>",
        integer=True,
        default=DEFAULT_POLL_INTERVAL,
    )
    response = await wait_for(
        accessor,
        request_id,
        float(interval or 0),
        float(timeout or 0),
        client_name,
    )
    hint = f" Resume with: tvly research poll {sanitize_control(request_id)}"
    await finish_wait(
        streams,
        ctx,
        fl,
        response,
        request_id,
        output,
        float(timeout or 0),
        hint,
    )
    return streams.result()


async def status(
    accessor: TavilyAccessor,
    fl: FlagView,
    words: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if len(words) > 1:
        return too_many("status", words)
    request_id = words[0]
    if accessor.config.api_key is None:
        return require_key("research status")
    response = await tavily_request(
        accessor,
        "GET",
        f"research/{quote(request_id, safe='')}",
        timeout=RESEARCH_GET_TIMEOUT,
        client_name=client_name_of(fl),
    )
    streams = Streams()
    if fl.as_bool("json"):
        streams.out(json_text(response, False))
        return streams.result()
    state = field(response, "status")
    shown = "unknown" if state is None else js_text(state)
    safe_id = sanitize_control(request_id)
    streams.out(f"  Request:  {safe_id}")
    streams.out(f"  Status:   {sanitize_control(shown)}")
    if shown == "completed":
        streams.out(f"  Run 'tvly research poll {safe_id}' to view results.")
    elif shown == "failed":
        error = field(response, "error")
        streams.out(
            f"  Error: {sanitize_control('Unknown error' if error is None else error)}"
        )
    return streams.result()


async def poll(
    accessor: TavilyAccessor,
    fl: FlagView,
    words: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if len(words) > 1:
        return too_many("poll", words)
    request_id = words[0]
    output = resolve_output(fl, ctx, "research", request_id)
    if accessor.config.api_key is None:
        return require_key("research poll")
    timeout = typed_number(
        fl, "timeout", "--timeout <n>", integer=True, default=DEFAULT_TIMEOUT
    )
    interval = typed_number(
        fl,
        "poll_interval",
        "--poll-interval <n>",
        integer=True,
        default=DEFAULT_POLL_INTERVAL,
    )
    response = await wait_for(
        accessor,
        request_id,
        float(interval or 0),
        float(timeout or 0),
        client_name_of(fl),
    )
    streams = Streams()
    await finish_wait(
        streams, ctx, fl, response, request_id, output, float(timeout or 0)
    )
    return streams.result()


def refused_option(
    fl: FlagView, refused: tuple[tuple[str, str], ...]
) -> str | None:
    """The first option the verb does not take, as the line spelled it.

    Args:
        fl (FlagView): the line's flags.
        refused (tuple[tuple[str, str], ...]): (dest, spelling) pairs.
    """
    spelled = dict(refused)
    for dest, value in fl.occurrences(*spelled):
        if value is not False and value is not None:
            return spelled[dest]
    return None


async def research(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Deep research: start a task, check one, or wait for one.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): the verb and its operands.
        ctx (Context): the invocation context.
    """
    if not texts:
        if ctx.spec is None:
            raise RuntimeError("research needs its spec")
        page = node_help("tvly research", ctx.spec, UsageStyle.COMMANDER)
        return page.encode(), IOResult()
    fl = FlagView(ctx.flags, ctx.spec)
    verb, words = route(texts)
    if verb != "run":
        refused = refused_option(
            fl, STATUS_REFUSES if verb == "status" else RUN_ONLY
        )
        if refused is not None:
            return usage(f"error: unknown option '{refused}'")
    try:
        for name, flags in (
            ("poll_interval", "--poll-interval <n>"),
            ("timeout", "--timeout <n>"),
        ):
            typed_number(fl, name, flags, integer=True)
        if verb == "run":
            typed_choice(fl, "model", "--model <model>", MODELS)
            typed_choice(
                fl,
                "citation_format",
                "--citation-format <format>",
                CITATION_FORMATS,
            )
            return await run(accessor, fl, words, ctx)
        if verb == "status":
            return await status(accessor, fl, words, ctx)
        return await poll(accessor, fl, words, ctx)
    except InvalidOption as invalid:
        return usage(str(invalid))
