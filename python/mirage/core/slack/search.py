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
import copy
import logging
import re
from typing import Any

import aiohttp

from mirage.accessor.slack import SlackAccessor
from mirage.core.hierarchy.probe import row_at, rows_of
from mirage.core.hierarchy.scope import ROOT
from mirage.core.render.json import compact_json_bytes
from mirage.core.slack.channels import list_channels
from mirage.core.slack.client import slack_get, slack_search_available
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.events.payload import day_of
from mirage.core.slack.paginate import cursor_pages
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import record_queries
from mirage.vfs.secrets import reveal_secret

logger = logging.getLogger(__name__)

PAGE_SIZE = 100
MAX_PAGES = 10
# The conversations a search token's user may be in: channels and DMs.
_SEARCHED_TYPES = "public_channel,private_channel,im,mpim"
# The message containers each directory scope searches across.
_CONTAINERS = {
    ROOT: ("channels", "dms"),
    "channels_root": ("channels",),
    "dms_root": ("dms",),
}

# What a channel day's chat.jsonl holds besides the message text, file
# names and titles and reaction names Slack search covers, spelled as
# whole words (a key with an underscore is never one): the keys of a
# message, its blocks, files and attachments, their fixed values, file
# and MIME types, URL words and the wording of a join or leave message.
RECORD_KEYS = frozenset(
    {
        "accessory",
        "acrobat",
        "actions",
        "adobe",
        "ai",
        "apk",
        "app",
        "apple",
        "applescript",
        "application",
        "apps",
        "archive",
        "archives",
        "attachments",
        "audio",
        "auto",
        "avatar",
        "avatars",
        "basic",
        "binary",
        "blocks",
        "bmp",
        "bold",
        "border",
        "box",
        "boxnote",
        "broadcast",
        "bullet",
        "button",
        "c",
        "canvas",
        "cfm",
        "channel",
        "channels",
        "checkboxes",
        "clojure",
        "code",
        "coffeescript",
        "color",
        "com",
        "comma",
        "comment",
        "complete",
        "compressed",
        "content",
        "context",
        "count",
        "cpp",
        "created",
        "csharp",
        "csrc",
        "css",
        "csv",
        "d",
        "dart",
        "date",
        "datepicker",
        "deanimate",
        "deleted",
        "diff",
        "divider",
        "doc",
        "dockerfile",
        "docs",
        "document",
        "docx",
        "dotx",
        "download",
        "dropbox",
        "edge",
        "edit",
        "editable",
        "edited",
        "element",
        "elements",
        "email",
        "emoji",
        "enterprise",
        "eps",
        "epub",
        "erlang",
        "everyone",
        "excel",
        "external",
        "fallback",
        "false",
        "fields",
        "file",
        "files",
        "filetype",
        "fla",
        "flash",
        "flv",
        "footer",
        "format",
        "fortran",
        "fsharp",
        "gdoc",
        "gdrive",
        "gif",
        "go",
        "google",
        "gpres",
        "gravatar",
        "groovy",
        "groups",
        "gsheet",
        "gzip",
        "handlebars",
        "has",
        "haskell",
        "haxe",
        "header",
        "heic",
        "here",
        "hidden",
        "highlight",
        "hls",
        "hosted",
        "html",
        "http",
        "https",
        "icons",
        "id",
        "illustrator",
        "image",
        "img",
        "ims",
        "indd",
        "indent",
        "indesign",
        "input",
        "inviter",
        "italic",
        "java",
        "javascript",
        "joined",
        "jpeg",
        "jpg",
        "json",
        "keynote",
        "kotlin",
        "label",
        "latex",
        "left",
        "lines",
        "link",
        "lisp",
        "list",
        "locale",
        "lua",
        "markdown",
        "matlab",
        "message",
        "metadata",
        "mhtml",
        "mimetype",
        "mkv",
        "mode",
        "mov",
        "mpeg",
        "mpg",
        "mrkdwn",
        "ms",
        "msword",
        "mumps",
        "name",
        "null",
        "numbers",
        "nzb",
        "objc",
        "objective",
        "ocaml",
        "octet",
        "odg",
        "odi",
        "odp",
        "ods",
        "odt",
        "officedocument",
        "offset",
        "ogg",
        "ogv",
        "onedrive",
        "openxmlformats",
        "options",
        "ordered",
        "overflow",
        "pages",
        "pascal",
        "pdf",
        "perl",
        "permalink",
        "photoshop",
        "php",
        "pig",
        "placeholder",
        "plain",
        "png",
        "post",
        "powerpoint",
        "powershell",
        "ppt",
        "pptx",
        "presentation",
        "presentationml",
        "pretext",
        "preview",
        "pri",
        "private",
        "processing",
        "psd",
        "public",
        "puppet",
        "purpose",
        "python",
        "qtz",
        "quicktime",
        "quip",
        "r",
        "range",
        "reactions",
        "replies",
        "root",
        "rtf",
        "ruby",
        "rust",
        "s",
        "sass",
        "scala",
        "scheme",
        "script",
        "section",
        "secure",
        "separated",
        "sh",
        "shares",
        "sheet",
        "sheets",
        "shell",
        "short",
        "size",
        "sketch",
        "slack",
        "slides",
        "smalltalk",
        "snippet",
        "source",
        "space",
        "spreadsheet",
        "spreadsheetml",
        "sql",
        "state",
        "status",
        "stream",
        "strike",
        "style",
        "subscribed",
        "subtype",
        "svg",
        "swf",
        "swift",
        "tab",
        "tar",
        "tarball",
        "team",
        "text",
        "the",
        "tiff",
        "timepicker",
        "timestamp",
        "title",
        "tmb",
        "tombstone",
        "toml",
        "topic",
        "transcription",
        "true",
        "ts",
        "tsv",
        "type",
        "typescript",
        "unicode",
        "unknown",
        "unlink",
        "updated",
        "upload",
        "url",
        "user",
        "usergroup",
        "username",
        "users",
        "value",
        "values",
        "vb",
        "vbscript",
        "vcard",
        "velocity",
        "verbatim",
        "verilog",
        "video",
        "visible",
        "visual",
        "vnd",
        "vtt",
        "wav",
        "webm",
        "webp",
        "wmv",
        "word",
        "wordprocessingml",
        "x",
        "xls",
        "xlsb",
        "xlsm",
        "xlsx",
        "xltx",
        "xml",
        "yaml",
        "zip",
    }
)


def search_available(config: SlackConfig) -> bool:
    return slack_search_available(config)


async def search_messages(
    accessor: SlackAccessor, query: str, count: int = 20, page: int = 1
) -> bytes:
    """Search messages across workspace (single page).

    Args:
        accessor (SlackAccessor): Slack accessor.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(accessor, "search.messages", params=params)
    return compact_json_bytes(data)


async def search_files(
    accessor: SlackAccessor, query: str, count: int = 20, page: int = 1
) -> bytes:
    """Search files across workspace via search.files (single page).

    Args:
        accessor (SlackAccessor): Slack accessor.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(accessor, "search.files", params=params)
    return compact_json_bytes(data)


async def _fetch_name_words(accessor: SlackAccessor) -> frozenset[str]:
    names: list[Any] = []
    async for page in cursor_pages(
        accessor, "users.list", base_params={"limit": 200}, items_key="members"
    ):
        for user in page:
            profile = user.get("profile") or {}
            names += [
                user.get("name"),
                user.get("real_name"),
                profile.get("real_name"),
                profile.get("display_name"),
                profile.get("first_name"),
            ]
    auth = await slack_get(accessor, "auth.test")
    names.append(auth.get("url"))
    words: set[str] = set()
    for name in names:
        if isinstance(name, str):
            words.update(re.findall(r"[a-z]+", name.lower()))
    return frozenset(words)


async def _fetch_search_facts(
    accessor: SlackAccessor,
) -> tuple[frozenset[str], frozenset[str] | None]:
    """The name words, then the channels search covers.

    One after the other, so a failed users.list leaves no channel listing
    paging on after the search has given up.

    Args:
        accessor (SlackAccessor): the workspace.
    """
    words = await _fetch_name_words(accessor)
    return words, await _searched_channels(accessor)


async def _search_facts(
    accessor: SlackAccessor,
) -> tuple[frozenset[str], frozenset[str] | None] | None:
    """The words of every user's name and of the workspace's domain, and
    the channels search covers (``_searched_channels``).

    A message may carry its author's profile and a file its permalink on
    the workspace's domain. The patterns of one grep ask at once, so the
    first fetches in its own task and the rest wait for its answer; a
    later command fetches again and sees a user or channel added since.
    None to a waiter when that fetch failed or its command was stopped.

    Args:
        accessor (SlackAccessor): the workspace.
    """
    loop = asyncio.get_running_loop()
    shared = accessor.search_facts
    if shared is not None and shared.get_loop() is loop:
        return await asyncio.shield(shared)
    ready: asyncio.Future[
        tuple[frozenset[str], frozenset[str] | None] | None
    ] = loop.create_future()
    accessor.search_facts = ready
    facts: tuple[frozenset[str], frozenset[str] | None] | None = None
    try:
        facts = await _fetch_search_facts(accessor)
        return facts
    finally:
        ready.set_result(facts)
        if accessor.search_facts is ready:
            accessor.search_facts = None


async def _matches(
    accessor: SlackAccessor, method: str, key: str, query: str
) -> list[dict[str, Any]] | None:
    found: list[dict[str, Any]] = []
    page = 1
    while True:
        data = await slack_get(
            accessor,
            method,
            params={
                "query": query,
                "count": PAGE_SIZE,
                "page": page,
                "sort": "timestamp",
            },
        )
        block = data.get(key) or {}
        found.extend(block.get("matches") or [])
        if page >= int((block.get("paging") or {}).get("pages") or 1):
            return found
        if page >= MAX_PAGES:
            return None
        page += 1


def _shares_of(value: Any) -> list[tuple[str, str]] | None:
    """The channel and UTC day of every message that shares a file.

    A file's ``timestamp`` is its upload, and a share on a later day puts
    the file in that day's history; ``shares`` names each one. None when
    the file names no shares.

    Args:
        value (Any): the file's ``shares``.
    """
    if not isinstance(value, dict):
        return None
    found: list[tuple[str, str]] = []
    for channels in value.values():
        if not isinstance(channels, dict):
            return None
        for cid, rows in channels.items():
            if not isinstance(rows, list):
                return None
            for row in rows:
                day = day_of(row.get("ts") if isinstance(row, dict) else None)
                if day is None:
                    return None
                found.append((cid, day))
    return found


async def _hits_of(
    accessor: SlackAccessor,
    within: str,
    queries: list[str],
    reaction: str | None,
) -> list[tuple[str, str]] | None:
    hits: list[tuple[str, str]] = []
    searches = [("search.messages", within + query) for query in queries]
    searches += [("search.files", within + query) for query in queries]
    if reaction is not None:
        searches.append(("search.messages", f"{within}has::{reaction}:"))
    for method, query in searches:
        key = method.removeprefix("search.")
        found = await _matches(accessor, method, key, query)
        if found is None:
            return None
        for item in found:
            if key == "files":
                shared = _shares_of(item.get("shares"))
                if shared is None:
                    return None
                hits.extend(shared)
                continue
            day = day_of(item.get("ts"))
            if day is None:
                return None
            hits.append(((item.get("channel") or {}).get("id", ""), day))
    return hits


async def _searched_channels(
    accessor: SlackAccessor,
) -> frozenset[str] | None:
    """The channels and DMs search covers, or None when it covers every
    listed one.

    With ``search_token`` set, search runs as that token's user, who sees
    every public channel but only the private ones and DMs they are in;
    the listing's token may read a private channel or a DM they are not
    in (a bot's own DMs), whose days no search names. Without it both are
    the same user.

    Args:
        accessor (SlackAccessor): the workspace.
    """
    search_token = accessor.config.search_token
    if not reveal_secret(search_token):
        return None
    searcher = copy.copy(accessor)
    searcher.config = accessor.config.model_copy(
        update={"token": search_token}
    )
    return frozenset(
        channel["id"]
        for channel in await list_channels(searcher, types=_SEARCHED_TYPES)
    )


async def files_containing(
    accessor: SlackAccessor,
    text: str,
    under: list[PathSpec],
) -> list[PathSpec] | None:
    """The channel and DM days under ``under`` Slack search names.

    Slack matches whole words of message text, of file names and titles
    (``search.files``) and of reaction names (``has::name:``), so each hit
    names the UTC day its message was posted, or each day a file was
    shared. The root, ``channels``, ``dms`` and a DM are searched across
    the workspace, a channel with ``in:#name`` (``on:`` would read the
    day in the searcher's time zone); hits map to dirnames through the
    channel and DM ids the listing holds. A scope with no day in it adds
    nothing, and a day is cheaper to read than to search. None when a
    channel or DM in scope is one search does not cover
    (``_searched_channels``), when
    ``text`` could match the JSON around those fields
    (``record_queries``), a user's name or the workspace's domain
    (``_search_facts``), on an API or connection error, past ``MAX_PAGES``
    pages, or with no hit at all, since Slack indexes a message some time
    after it is posted.

    Args:
        accessor (SlackAccessor): the workspace.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    try:
        return await _search(accessor, text, queries, under)
    except (RuntimeError, aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.debug("slack search failed (%s); reading every file", exc)
        return None


async def _search(
    accessor: SlackAccessor,
    text: str,
    queries: list[str],
    under: list[PathSpec],
) -> list[PathSpec] | None:
    scopes = [(scope, detect_scope(scope)) for scope in under]
    if any(match.kind == "day" for _, match in scopes):
        return None
    words = text.lower().split()
    facts = await _search_facts(accessor)
    if facts is None:
        return None
    name_words, searched = facts
    if not set(words).isdisjoint(name_words):
        return None
    reaction = words[0] if len(words) == 1 else None
    found: list[PathSpec] = []
    for scope, match in scopes:
        if match.kind in _CONTAINERS:
            dirs: dict[str, str] = {}
            for container in _CONTAINERS[match.kind]:
                listed = await readdir(
                    accessor, mounted_path(scope, f"/{container}")
                )
                for row in rows_of(listed):
                    dirs[str(row.extra["channel_id"])] = (
                        f"{container}/{row.name}"
                    )
            within = ""
        elif match.kind == "channel":
            container = match.slots["container"]
            dirname = scope.mount_path.strip("/").split("/")[1]
            channel = mounted_path(scope, f"/{container}/{dirname}")
            entry, _ = await row_at(readdir, accessor, channel)
            if entry is None:
                return None
            dirs = {str(entry.extra["channel_id"]): f"{container}/{dirname}"}
            within = (
                f"in:#{entry.extra['name']} "
                if container == "channels"
                else ""
            )
        else:
            continue
        if searched is not None and not dirs.keys() <= searched:
            return None
        hits = await _hits_of(accessor, within, queries, reaction)
        if hits is None:
            return None
        found.extend(
            mounted_path(scope, f"/{dirs[cid]}/{posted}/chat.jsonl")
            for cid, posted in hits
            if cid in dirs
        )
    return found or None
