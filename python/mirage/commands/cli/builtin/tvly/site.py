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

# `tvly crawl` and `tvly map` adapted from tvly 1.0.2's
# src/commands/site.ts and src/ui/render/crawl.ts (MIT; see
# licenses/third_party/tavily-cli.txt).

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.extract import page_options
from mirage.commands.cli.builtin.tvly.failure import require_key, usage
from mirage.commands.cli.builtin.tvly.options import (
    InvalidOption,
    client_name_of,
    defined,
    split_csv,
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
    js_text,
    json_text,
    pages_text,
    plain,
    truthy,
)
from mirage.commands.cli.builtin.tvly.urls import host_of, page_slug
from mirage.commands.cli.operand import ensure_dir
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.tavily.client import tavily_request, timed_body
from mirage.core.tavily.constants import SITE_TIMEOUT
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

LISTS = ("select_paths", "exclude_paths", "select_domains", "exclude_domains")


def site_body(fl: FlagView, url: str) -> dict[str, JsonValue]:
    """The request fields crawl and map share, unset ones left out.

    Args:
        fl (FlagView): the line's flags.
        url (str): where to start.

    Raises:
        InvalidOption: a value is refused.
    """
    body: dict[str, JsonValue] = {"url": url}
    defined(
        body,
        "max_depth",
        typed_number(fl, "max_depth", "--max-depth <n>", integer=True),
    )
    defined(
        body,
        "max_breadth",
        typed_number(fl, "max_breadth", "--max-breadth <n>", integer=True),
    )
    defined(
        body, "limit", typed_number(fl, "limit", "--limit <n>", integer=True)
    )
    defined(body, "instructions", fl.as_str("instructions"))
    for key in LISTS:
        defined(body, key, split_csv(fl.as_str(key)))
    if fl.as_bool("no_external"):
        body["allow_external"] = False
    elif fl.as_bool("allow_external"):
        body["allow_external"] = True
    defined(
        body, "timeout", typed_number(fl, "timeout", "--timeout <seconds>")
    )
    return body


def single_url(texts: list[str], verb: str) -> str | tuple[None, IOResult]:
    """The one URL a site verb takes, or commander's refusal.

    Args:
        texts (list[str]): the line's operands.
        verb (str): the verb, as the refusal names it.
    """
    if not texts:
        return usage("error: missing required argument 'url'")
    if len(texts) > 1:
        return usage(
            f"error: too many arguments for '{verb}'. Expected 1 argument "
            f"but got {len(texts)}: {', '.join(texts)}."
        )
    return texts[0]


async def save_pages(
    streams: Streams, ctx: Context, data: JsonValue, folder: PathSpec
) -> None:
    """Write each page with content to ``<folder>/<slug>.md``.

    A slug already used in this crawl takes the first free ``-2``,
    ``-3``... suffix, compared without case so a case-insensitive
    filesystem cannot collide either.

    Args:
        streams (Streams): where the verb's output gathers.
        ctx (Context): the invocation context.
        data (JsonValue): the crawl's answer.
        folder (PathSpec): the directory to save into.
    """
    if ctx.vfs is None:
        raise RuntimeError("no workspace files")
    await ensure_dir(ctx.vfs, folder)
    used: set[str] = set()
    for page in items(field(data, "results")):
        content = field(page, "raw_content")
        if not truthy(content):
            continue
        url = field(page, "url")
        url_text = "" if url is None else js_text(url)
        slug = page_slug(url_text)
        name = slug
        n = 2
        while name.lower() in used:
            name = f"{slug}-{n}"
            n += 1
        used.add(name.lower())
        body = f"# {url_text}\n\n{js_text(content)}\n"
        await ctx.vfs.write(folder.join(f"{name}.md"), body.encode())
    streams.err(f"Saved {len(used)} pages to {folder.raw_path}/")


async def crawl(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Crawl a website from a URL, every page with its content.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): the URL.
        ctx (Context): the invocation context.
    """
    fl = FlagView(ctx.flags, ctx.spec)
    url_or_refusal = single_url(texts, "crawl")
    url = url_or_refusal if isinstance(url_or_refusal, str) else ""
    try:
        body = site_body(fl, url)
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
    except InvalidOption as refused:
        return usage(str(refused))
    if not isinstance(url_or_refusal, str):
        return url_or_refusal
    output = resolve_output(fl, ctx, "crawl", host_of(url))
    if accessor.config.api_key is None:
        return require_key("crawl")
    body, timeout = timed_body(body, SITE_TIMEOUT)
    data = await tavily_request(
        accessor,
        "POST",
        "crawl",
        body,
        timeout=timeout,
        client_name=client_name_of(fl),
    )
    streams = Streams()
    folder = fl.as_path("output_dir")
    if folder is not None:
        await save_pages(streams, ctx, data, folder)
        if json_requested(fl, output):
            await emit(streams, ctx, json_text(data, True), output)
        return streams.result()
    if json_requested(fl, output):
        await emit(streams, ctx, json_text(data, True), output)
        return streams.result()
    streams.stdout.append(pages_text(items(field(data, "results"))))
    return streams.result()


async def map_site(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Discover the URLs of a website, without their content.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): the URL.
        ctx (Context): the invocation context.
    """
    fl = FlagView(ctx.flags, ctx.spec)
    url_or_refusal = single_url(texts, "map")
    url = url_or_refusal if isinstance(url_or_refusal, str) else ""
    try:
        body = site_body(fl, url)
    except InvalidOption as refused:
        return usage(str(refused))
    if not isinstance(url_or_refusal, str):
        return url_or_refusal
    output = resolve_output(fl, ctx, "map", host_of(url))
    if accessor.config.api_key is None:
        return require_key("map")
    body, timeout = timed_body(body, SITE_TIMEOUT)
    data = await tavily_request(
        accessor,
        "POST",
        "map",
        body,
        timeout=timeout,
        client_name=client_name_of(fl),
    )
    streams = Streams()
    if json_requested(fl, output):
        await emit(streams, ctx, json_text(data, True), output)
        return streams.result()
    for found in items(field(data, "results")):
        streams.out(plain(found))
    return streams.result()
