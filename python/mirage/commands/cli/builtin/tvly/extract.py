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

# `tvly extract` adapted from tvly 1.0.2's src/commands/extract.ts and
# src/ui/render/extract.ts (MIT; see licenses/third_party/tavily-cli.txt).

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.failure import usage
from mirage.commands.cli.builtin.tvly.options import (
    InvalidOption,
    client_name_of,
    defined,
    typed_choice,
    typed_number,
)
from mirage.commands.cli.builtin.tvly.output import (
    Streams,
    emit,
    json_requested,
    resolve_output,
)
from mirage.commands.cli.builtin.tvly.render import (
    field,
    items,
    json_text,
    member_text,
    pages_text,
    plain,
)
from mirage.commands.cli.builtin.tvly.urls import hostname_of
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.tavily.client import tavily_request, timed_body
from mirage.core.tavily.constants import EXTRACT_TIMEOUT
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

MAX_URLS = 20
EXTRACT_DEPTHS = ("basic", "advanced")
FORMATS = ("markdown", "text")


def page_options(fl: FlagView, body: dict[str, JsonValue]) -> None:
    """Set what ``--extract-depth``, ``--format`` and ``--include-images``
    ask, the content options extract and crawl share.

    Args:
        fl (FlagView): the line's flags.
        body (dict[str, JsonValue]): the request body being built.

    Raises:
        InvalidOption: a value is refused.
    """
    defined(
        body,
        "extract_depth",
        typed_choice(
            fl, "extract_depth", "--extract-depth <depth>", EXTRACT_DEPTHS
        ),
    )
    defined(
        body,
        "format",
        typed_choice(fl, "format", "--format <format>", FORMATS),
    )
    if fl.as_bool("include_images"):
        body["include_images"] = True


async def extract(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Extract the content of up to twenty URLs.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): the URLs.
        ctx (Context): the invocation context.
    """
    fl = FlagView(ctx.flags, ctx.spec)
    body: dict[str, JsonValue] = {"urls": list(texts)}
    try:
        defined(body, "query", fl.as_str("query"))
        defined(
            body,
            "chunks_per_source",
            typed_number(
                fl,
                "chunks_per_source",
                "--chunks-per-source <n>",
                integer=True,
            ),
        )
        page_options(fl, body)
        defined(
            body,
            "timeout",
            typed_number(fl, "timeout", "--timeout <seconds>"),
        )
    except InvalidOption as refused:
        return usage(str(refused))
    if not texts:
        return usage("error: missing required argument 'urls'")
    if len(texts) > MAX_URLS:
        return usage(f"error: Maximum {MAX_URLS} URLs per request.")
    output = resolve_output(fl, ctx, "extract", hostname_of(texts[0]))
    body, timeout = timed_body(body, EXTRACT_TIMEOUT)
    data = await tavily_request(
        accessor,
        "POST",
        "extract",
        body,
        timeout=timeout,
        client_name=client_name_of(fl),
    )
    streams = Streams()
    if json_requested(fl, output):
        await emit(streams, ctx, json_text(data, True), output)
        return streams.result()
    streams.stdout.append(pages_text(items(field(data, "results"))))
    for failed in items(field(data, "failed_results")):
        url = plain(member_text(failed, "url"))
        error = plain(member_text(failed, "error"))
        streams.out(f"Failed: {url}: {error}")
    return streams.result()
