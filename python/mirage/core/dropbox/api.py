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

from typing import Any

from mirage.core.dropbox._client import DropboxTokenManager, dropbox_rpc

SEARCH_PAGE = 1000
# search_v2 + search/continue_v2 serve at most 10,000 matches total; a
# result set that hits the ceiling may be incomplete and must not be used
# to narrow a scan.
MAX_SEARCH_MATCHES = 10_000


async def get_metadata(tm: DropboxTokenManager, path: str) -> dict[str, Any]:
    return await dropbox_rpc(tm, "/files/get_metadata", {"path": path})


async def create_folder(tm: DropboxTokenManager, path: str) -> None:
    await dropbox_rpc(tm, "/files/create_folder_v2", {
        "path": path,
        "autorename": False,
    })


async def delete_path(tm: DropboxTokenManager, path: str) -> None:
    await dropbox_rpc(tm, "/files/delete_v2", {"path": path})


async def move_path(tm: DropboxTokenManager, from_path: str,
                    to_path: str) -> None:
    await dropbox_rpc(tm, "/files/move_v2", {
        "from_path": from_path,
        "to_path": to_path,
        "autorename": False,
    })


async def copy_path(tm: DropboxTokenManager, from_path: str,
                    to_path: str) -> None:
    await dropbox_rpc(tm, "/files/copy_v2", {
        "from_path": from_path,
        "to_path": to_path,
        "autorename": False,
    })


async def search_files(
    tm: DropboxTokenManager,
    query: str,
    path: str = "",
    filename_only: bool = False,
) -> tuple[list[tuple[str, str]], bool]:
    """Collect (path_lower, path_display) file matches for a search query.

    Pages through ``/files/search_v2`` and ``/files/search/continue_v2``,
    deduplicating across pages (the API may repeat results between pages).

    Args:
        tm (DropboxTokenManager): token manager for the account.
        query (str): literal search query.
        path (str): Dropbox API path scoping the search; ``""`` searches
            the whole account.
        filename_only (bool): restrict matching to file names.

    Returns:
        tuple[list[tuple[str, str]], bool]: matched file paths and whether
            the result hit the API's 10,000-match ceiling (truncated
            results are not a trustworthy superset).
    """
    options: dict[str, Any] = {
        "max_results": SEARCH_PAGE,
        "file_status": "active",
        "filename_only": filename_only,
    }
    if path:
        options["path"] = path
    resp = await dropbox_rpc(tm, "/files/search_v2", {
        "query": query,
        "options": options,
    })
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    while True:
        for match in resp.get("matches", []):
            meta = match.get("metadata", {}).get("metadata", {})
            if meta.get(".tag") != "file":
                continue
            lower = meta.get("path_lower") or ""
            display = meta.get("path_display") or lower
            if not lower or lower in seen:
                continue
            seen.add(lower)
            out.append((lower, display))
        if len(out) >= MAX_SEARCH_MATCHES:
            return out, True
        if not resp.get("has_more"):
            return out, False
        resp = await dropbox_rpc(tm, "/files/search/continue_v2",
                                 {"cursor": resp["cursor"]})


async def list_folder(
    tm: DropboxTokenManager,
    path: str,
    recursive: bool = False,
    limit: int = 2000,
) -> list[dict[str, Any]]:
    api_path = "" if path in ("/", "") else path
    out: list[dict[str, Any]] = []
    resp = await dropbox_rpc(tm, "/files/list_folder", {
        "path": api_path,
        "recursive": recursive,
        "limit": limit,
    })
    out.extend(resp["entries"])
    while resp.get("has_more"):
        resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                                 {"cursor": resp["cursor"]})
        out.extend(resp["entries"])
    return out
