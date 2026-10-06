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

from collections.abc import Callable

from aiohttp import ClientResponseError

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import get_file
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def resolve_app_entry(
    token_manager: TokenManager,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
    mime: str,
    resource_type: str,
    filename: Callable[[str, str, str], str],
) -> IndexEntry:
    """Resolve a native app file without an account-wide search.

    Args:
        token_manager (TokenManager): authenticated Drive client.
        match (ScopeMatch): decoded corpus and file ID.
        path (PathSpec): requested file.
        index (IndexCacheStore): existing listing metadata.
        mime (str): the app's Drive MIME type.
        resource_type (str): the app's index resource type.
        filename (Callable): renders the canonical filename.
    """
    parent = path.virtual.rsplit("/", 1)[0]
    listing = await index.list_dir(parent)
    if listing.entries is not None and path.virtual not in listing.entries:
        raise enoent(path.virtual)
    hit = await index.get(path.virtual)
    if hit.entry is not None and path.virtual in (
        listing.entries or listing.partial_entries or []
    ):
        return hit.entry
    try:
        item = await get_file(token_manager, match.slots["file_id"])
    except ClientResponseError as exc:
        if exc.status != 404:
            raise
        await index.invalidate_prefix(path.virtual)
        raise enoent(path.virtual) from exc
    modified = item.get("modifiedTime", "")
    name = filename(item["name"], item["id"], modified)
    owners = item.get("owners", [])
    owned = bool(owners) and owners[0].get("me") is True
    if (
        item.get("trashed", False)
        or item.get("mimeType") != mime
        or owned != (match.slots["corpus"] == "owned")
        or name != path.vfs_path.rsplit("/", 1)[-1]
    ):
        await index.invalidate_prefix(path.virtual)
        raise enoent(path.virtual)
    source_size = int(item.get("size") or item.get("quotaBytesUsed") or 0)
    entry = IndexEntry(
        id=item["id"],
        name=item["name"],
        resource_type=resource_type,
        remote_time=modified,
        vfs_name=name,
        extra={"source_size": source_size} if source_size > 0 else {},
    )
    await index.put(path.virtual, entry)
    return entry
