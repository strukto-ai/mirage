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
import re
from datetime import datetime, timezone
from typing import Any

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.api.client import SessionArg
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ROOT
from mirage.core.render.json import compact_json_bytes
from mirage.core.slack.client import slack_get, slack_search_available
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.paginate import cursor_pages
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.naming import parse_id_name
from mirage.utils.record_search import record_queries

logger = logging.getLogger(__name__)

PAGE_SIZE = 100
MAX_PAGES = 10

# What a channel day's chat.jsonl holds besides the message text, file
# names and titles and reaction names Slack search covers: key names,
# JSON literals, file types, download URLs and the wording of a join or
# leave message.
RECORD_KEYS = frozenset(
    {
        "type",
        "message",
        "subtype",
        "user",
        "text",
        "ts",
        "reactions",
        "name",
        "users",
        "count",
        "files",
        "file",
        "id",
        "title",
        "mimetype",
        "filetype",
        "size",
        "timestamp",
        "team",
        "blocks",
        "elements",
        "edited",
        "attachments",
        "username",
        "permalink",
        "true",
        "false",
        "null",
        "http",
        "https",
        "slack",
        "com",
        "pri",
        "download",
        "plain",
        "csv",
        "markdown",
        "html",
        "json",
        "image",
        "png",
        "jpeg",
        "jpg",
        "gif",
        "video",
        "audio",
        "application",
        "pdf",
        "zip",
        "octet",
        "stream",
        "vnd",
        "openxmlformats",
        "officedocument",
        "presentationml",
        "presentation",
        "spreadsheetml",
        "sheet",
        "wordprocessingml",
        "document",
        "docs",
        "pptx",
        "xlsx",
        "docx",
        "quip",
        "binary",
        "has",
        "joined",
        "left",
        "the",
        "channel",
    }
)


def search_available(config: SlackConfig) -> bool:
    return slack_search_available(config)


async def search_messages(
    config: SlackConfig,
    query: str,
    count: int = 20,
    page: int = 1,
    session: SessionArg = None,
) -> bytes:
    """Search messages across workspace (single page).

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(
        config, "search.messages", params=params, session=session
    )
    return compact_json_bytes(data)


async def search_files(
    config: SlackConfig,
    query: str,
    count: int = 20,
    page: int = 1,
    session: SessionArg = None,
) -> bytes:
    """Search files across workspace via search.files (single page).

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(
        config, "search.files", params=params, session=session
    )
    return compact_json_bytes(data)


async def _name_words(accessor: SlackAccessor) -> set[str]:
    words: set[str] = set()
    async for page in cursor_pages(
        accessor.config,
        "users.list",
        base_params={"limit": 200},
        items_key="members",
        session=accessor.pool,
    ):
        for user in page:
            profile = user.get("profile") or {}
            for name in (
                user.get("name"),
                user.get("real_name"),
                profile.get("real_name"),
                profile.get("display_name"),
            ):
                if isinstance(name, str):
                    words.update(re.findall(r"[a-z]+", name.lower()))
    return words


def _day_of(ts: Any) -> str | None:
    try:
        moment = datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return moment.date().isoformat()


async def _matches(
    accessor: SlackAccessor, method: str, key: str, query: str
) -> list[dict[str, Any]] | None:
    found: list[dict[str, Any]] = []
    page = 1
    while True:
        data = await slack_get(
            accessor.config,
            method,
            params={
                "query": query,
                "count": PAGE_SIZE,
                "page": page,
                "sort": "timestamp",
            },
            session=accessor.pool,
        )
        block = data.get(key) or {}
        found.extend(block.get("matches") or [])
        if page >= int((block.get("paging") or {}).get("pages") or 1):
            return found
        if page >= MAX_PAGES:
            return None
        page += 1


async def _hits(
    accessor: SlackAccessor,
    within: str,
    queries: list[str],
    reaction: str | None,
    channel_id: str | None,
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
            if key == "messages":
                ids = [(item.get("channel") or {}).get("id", "")]
                day = _day_of(item.get("ts"))
            else:
                ids = [
                    *(item.get("channels") or []),
                    *(item.get("groups") or []),
                ]
                ids = ids or ([channel_id] if channel_id else [])
                day = _day_of(item.get("timestamp"))
            if day is None or not ids:
                return None
            hits.extend((cid, day) for cid in ids)
    return hits


async def files_containing(
    accessor: SlackAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The channel days under ``under`` Slack search names.

    Slack matches whole words of message text, of file names and titles
    (``search.files``) and of reaction names (``has::name:``), so each hit
    names the UTC day its message or file was posted. The root and
    ``channels`` are searched across the workspace, a channel or a day
    with ``in:#name`` (``on:`` would read the day in the searcher's time
    zone); hits map to dirnames through the channel ids the listing
    holds. A scope with no channel day in it adds nothing. None
    when ``text`` could match the JSON around those fields
    (``record_queries``) or a user's name (a message may carry its
    author's profile), on an API error, past ``MAX_PAGES`` pages, or
    with no hit at all, since Slack indexes a message some time after it
    is posted.

    Args:
        accessor (SlackAccessor): the workspace.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the listings the walk filled.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    try:
        return await _search(accessor, text, queries, under, index)
    except RuntimeError as exc:
        logger.warning("slack search failed (%s); reading every file", exc)
        return None


async def _search(
    accessor: SlackAccessor,
    text: str,
    queries: list[str],
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    words = text.lower().split()
    if not set(words).isdisjoint(await _name_words(accessor)):
        return None
    reaction = words[0] if len(words) == 1 else None
    found: list[PathSpec] = []
    for scope in under:
        match = detect_scope(scope)
        if match.kind in (ROOT, "channels_root"):
            listed = await readdir(
                accessor, mounted_path(scope, "/channels"), index
            )
            names = [path.rsplit("/", 1)[-1] for path in listed]
            dirs = {parse_id_name(name)[1]: name for name in names}
            within, channel_id = "", None
        elif (
            match.kind in ("channel", "day")
            and match.slots["container"] == "channels"
        ):
            dirname = scope.mount_path.strip("/").split("/")[1]
            channel = mounted_path(scope, f"/channels/{dirname}")
            entry = await resolve_entry(readdir, accessor, channel, index)
            if entry is None:
                return None
            dirs = {entry.id: dirname}
            within, channel_id = f"in:#{entry.name} ", entry.id
        else:
            continue
        hits = await _hits(accessor, within, queries, reaction, channel_id)
        if hits is None:
            return None
        found.extend(
            mounted_path(scope, f"/channels/{dirs[cid]}/{posted}/chat.jsonl")
            for cid, posted in hits
            if cid in dirs
        )
    return found or None
