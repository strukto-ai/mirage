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

from mirage.core.dropbox.client import DropboxTokenManager, dropbox_rpc

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
    page_size: int = 2000,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """List a folder's entries, following every continuation cursor.

    Args:
        tm (DropboxTokenManager): Dropbox token manager.
        path (str): folder to list; "/" and "" both mean the account root.
        recursive (bool): list every descendant, not just the children.
        page_size (int): entries per request.
        limit (int | None): stop once this many entries are in hand and do
            not request another page. An emptiness probe wants one entry,
            and ``page_size`` alone cannot express that: it caps the page,
            not the walk, so a small page turned a listing of a large
            folder into many requests instead of fewer.

    Returns:
        list[dict]: entry metadata dicts.
    """
    api_path = "" if path in ("/", "") else path
    out: list[dict[str, Any]] = []
    resp = await dropbox_rpc(
        tm, "/files/list_folder", {
            "path": api_path,
            "recursive": recursive,
            "limit": page_size if limit is None else min(page_size, limit),
        })
    out.extend(resp["entries"])
    while resp.get("has_more"):
        if limit is not None and len(out) >= limit:
            break
        resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                                 {"cursor": resp["cursor"]})
        out.extend(resp["entries"])
    return out


async def list_folder_state(
    tm: DropboxTokenManager,
    path: str,
    recursive: bool = False,
    page_size: int = 2000,
) -> tuple[list[dict[str, Any]], str]:
    """List a folder and keep the cursor the last page handed back.

    Args:
        tm (DropboxTokenManager): Dropbox token manager.
        path (str): folder to list; "/" and "" both mean the account root.
        recursive (bool): list every descendant, not just the children.
        page_size (int): entries per request.

    Returns:
        tuple[list[dict], str]: entry metadata and the opaque cursor.
    """
    api_path = "" if path in ("/", "") else path
    out: list[dict[str, Any]] = []
    resp = await dropbox_rpc(tm, "/files/list_folder", {
        "path": api_path,
        "recursive": recursive,
        "limit": page_size,
    })
    out.extend(resp["entries"])
    while resp.get("has_more"):
        resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                                 {"cursor": resp["cursor"]})
        out.extend(resp["entries"])
    return out, resp["cursor"]


async def continue_folder(
    tm: DropboxTokenManager,
    cursor: str,
) -> tuple[list[dict[str, Any]], str]:
    """Replay changes since ``cursor``, following every continuation page.

    Args:
        tm (DropboxTokenManager): Dropbox token manager.
        cursor (str): opaque cursor from a previous list or continue.

    Returns:
        tuple[list[dict], str]: changed entries (including deleted) and
            the next cursor.
    """
    out: list[dict[str, Any]] = []
    resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                             {"cursor": cursor})
    out.extend(resp["entries"])
    while resp.get("has_more"):
        resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                                 {"cursor": resp["cursor"]})
        out.extend(resp["entries"])
    return out, resp["cursor"]
