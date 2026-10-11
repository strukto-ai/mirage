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
import logging

import aiohttp

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gmail.date_query import date_dir_to_gmail_query
from mirage.core.gmail.messages import list_message_page
from mirage.core.gmail.readdir import readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ROOT
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import record_queries

logger = logging.getLogger(__name__)

MAX_HITS = 500

# What a .gmail.json holds besides the headers, body and attachment names
# Gmail searches: its key names, JSON literals and system label ids. The
# snippet, the Date header and the attachments' MIME types are checked
# against the listing instead (``unsearched_text``).
RECORD_KEYS = frozenset(
    {
        "id",
        "from",
        "name",
        "email",
        "to",
        "cc",
        "subject",
        "date",
        "snippet",
        "labels",
        "attachments",
        "filename",
        "path",
        "size",
        "true",
        "false",
        "null",
        "inbox",
        "sent",
        "draft",
        "spam",
        "trash",
        "unread",
        "starred",
        "important",
        "chat",
    }
)


def _name_of(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def _child_of(directory: PathSpec, name: str) -> PathSpec:
    return mounted_path(
        directory, f"{directory.mount_path.rstrip('/')}/{name}"
    )


async def _messages_under(
    accessor: GmailAccessor,
    directory: PathSpec,
    text: str,
    index: IndexCacheStore,
) -> tuple[dict[str, list[PathSpec]], set[str]] | None:
    """The message files under ``directory`` by id, and the ids whose
    unsearched text (``unsearched_text``) holds ``text``; None when a
    listing does not carry that text.
    """
    found: dict[str, list[PathSpec]] = {}
    unsearched: set[str] = set()
    pending = [directory]
    while pending:
        current = pending.pop()
        for listed in await readdir(accessor, current, index):
            child = _child_of(current, _name_of(listed))
            kind = detect_scope(child).kind
            if kind == "day":
                pending.append(child)
            elif kind == "message":
                entry = await resolve_entry(readdir, accessor, child, index)
                if entry is None or "unsearched" not in entry.extra:
                    return None
                found.setdefault(entry.id, []).append(child)
                if text.lower() in entry.extra["unsearched"]:
                    unsearched.add(entry.id)
    return found, unsearched


async def _hits_under(
    accessor: GmailAccessor,
    directory: PathSpec,
    text: str,
    queries: list[str],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    match = detect_scope(directory)
    label = mounted_path(directory, "/" + match.slots["label"])
    entry = await resolve_entry(readdir, accessor, label, index)
    day = match.slots.get("day")
    bound = date_dir_to_gmail_query(day) if day else ""
    if entry is None or bound is None:
        return None
    ids: set[str] = set()
    for query in queries:
        stubs, more = await list_message_page(
            accessor.token_manager,
            label_id=entry.id,
            query=f"{query} {bound}".strip(),
            max_results=MAX_HITS,
        )
        if more is not None or len(stubs) >= MAX_HITS:
            return None
        ids.update(stub["id"] for stub in stubs)
    walked = await _messages_under(accessor, directory, text, index)
    if walked is None:
        return None
    files, unsearched = walked
    return [
        path
        for message_id in ids | unsearched
        for path in files.get(message_id, [])
    ]


async def files_containing(
    accessor: GmailAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The message files under ``under`` Gmail search names.

    Gmail matches whole words of the headers, the body and (with
    ``filename:``) attachment names, so each hit is a message that may
    hold ``text``. Each label is searched on its own, since an account
    search leaves out spam and trash; a day adds its UTC bounds. Hits map
    to files by the message id the listing names them with, and a message
    whose snippet or attachment MIME type holds ``text`` is a hit too:
    Gmail does not search them, and the listing keeps them. None when
    ``text`` could match the JSON around those fields
    (``record_queries``), on an API or connection error, at ``MAX_HITS``
    hits or when the answer names a next page, or with no hit at all,
    since Gmail indexes a message some time after it arrives.

    Args:
        accessor (GmailAccessor): the account.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the listings the walk filled.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    queries += [f"filename:{query.split()[0]}" for query in queries]
    found: list[PathSpec] = []
    try:
        for scope in under:
            match = detect_scope(scope)
            if match.kind == ROOT:
                listed = await readdir(accessor, scope, index)
                labels = [_child_of(scope, _name_of(p)) for p in listed]
            elif match.kind in ("label", "day"):
                labels = [scope]
            else:
                continue
            for directory in labels:
                hits = await _hits_under(
                    accessor, directory, text, queries, index
                )
                if hits is None:
                    return None
                found.extend(hits)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.warning("gmail search failed (%s); reading every file", exc)
        return None
    return found or None
