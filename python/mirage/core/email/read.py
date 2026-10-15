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

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.email.client import (
    fetch_attachment,
    fetch_headers,
    fetch_message,
)
from mirage.core.email.readdir import readdir
from mirage.core.email.render import message_json_bytes
from mirage.core.email.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import FileStat, PathSpec


async def _read_message(
    accessor: EmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if entry is None:
        raise enoent(path.virtual)
    msg = await fetch_message(
        accessor, match.slots["folder"], str(entry.extra["uid"])
    )
    return message_json_bytes(msg)


async def _read_attachment(
    accessor: EmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if entry is None:
        raise enoent(path.virtual)
    data = await fetch_attachment(
        accessor, match.slots["folder"], match.slots["uid"], entry.name
    )
    if data is None:
        raise enoent(path.virtual)
    return data


read = make_read(
    detect_scope,
    readers={
        "message": _read_message,
        "attachment": _read_attachment,
    },
)


async def read_many(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    limit: int,
    index: IndexCacheStore = NULL_INDEX,
) -> dict[str, bytes]:
    """Several message files, one UID FETCH per folder for all of them.

    A path that is no message file, one its folder's listing does not
    hold, and one past ``limit`` bytes (as the listing sizes it, before
    the fetch) is left out for its own read to answer.

    Args:
        accessor (EmailAccessor): the account.
        paths (list[PathSpec]): the files.
        limit (int): the most bytes worth reading for one file.
        index (IndexCacheStore): index cache.
    """
    folders: dict[str, dict[str, str]] = {}
    for path in paths:
        match = detect_scope(path)
        if match.kind != "message":
            continue
        entry = await resolve_entry(readdir, accessor, path, index)
        if entry is not None and (entry.size or 0) <= limit:
            folders.setdefault(match.slots["folder"], {})[entry.id] = (
                path.virtual
            )
    answers: dict[str, bytes] = {}
    for folder, uids in folders.items():
        for msg in await fetch_headers(accessor, folder, list(uids)):
            virtual = uids.get(str(msg.get("uid")))
            body = message_json_bytes(msg)
            if virtual is not None and len(body) <= limit:
                answers[virtual] = body
    return answers
