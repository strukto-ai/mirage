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
from typing import Any

from aiohttp import ClientResponseError

from mirage.core.google.client import TokenManager
from mirage.core.google.drive import get_file
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec


def app_file(name: str, item: dict[str, Any]) -> FileStat:
    """A native app file as its corpus listing names it and stat answers.

    The size stays None: Drive reports the source document's storage
    size, not the rendered JSON length (FileStat.size must be
    render-derived or None, see the CLAUDE.md FUSE rules). The source
    size rides in ``extra``.

    Args:
        name (str): the app's file name for the item.
        item (dict[str, Any]): the Drive file resource.
    """
    modified = item.get("modifiedTime") or None
    extra: dict[str, Any] = {"doc_id": item["id"], "doc_name": item["name"]}
    source_size = int(item.get("size") or item.get("quotaBytesUsed") or 0)
    if source_size > 0:
        extra["source_size"] = source_size
    return FileStat(
        name=name,
        type=FileType.FILE,
        content=ContentType.JSON,
        modified=modified,
        fingerprint=modified,
        extra=extra,
    )


async def resolve_app_entry(
    token_manager: TokenManager,
    match: ScopeMatch,
    path: PathSpec,
    mime: str,
    filename: Callable[[str, str, str], str],
) -> FileStat:
    """Resolve a native app file by the id in its name, without an
    account-wide search: a path no listing has named is fetched alone.

    Args:
        token_manager (TokenManager): authenticated Drive client.
        match (ScopeMatch): decoded corpus and file ID.
        path (PathSpec): requested file.
        mime (str): the app's Drive MIME type.
        filename (Callable): renders the canonical filename.
    """
    try:
        item = await get_file(token_manager, match.slots["file_id"])
    except ClientResponseError as exc:
        if exc.status != 404:
            raise
        raise enoent(path.virtual) from exc
    name = filename(item["name"], item["id"], item.get("modifiedTime", ""))
    owners = item.get("owners", [])
    owned = bool(owners) and owners[0].get("me") is True
    if (
        item.get("trashed", False)
        or item.get("mimeType") != mime
        or owned != (match.slots["corpus"] == "owned")
        or name != path.vfs_path.rsplit("/", 1)[-1]
    ):
        raise enoent(path.virtual)
    return app_file(name, item)
