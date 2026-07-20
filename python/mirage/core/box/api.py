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

from collections.abc import AsyncIterator
from typing import Any

from mirage.core.box._client import (BoxTokenManager, box_delete, box_get,
                                     box_get_bytes, box_get_stream,
                                     box_post_json, box_put_json,
                                     box_upload_multipart)

LIST_FIELDS = "id,name,type,size,modified_at,etag,sha1,parent"
SEARCH_FIELDS = "id,name,type,path_collection"
SEARCH_PAGE = 200
# Box search serves at most 10,000 matches across all pages; a result set
# that reaches the ceiling may be incomplete and must not narrow a scan.
MAX_SEARCH_MATCHES = 10_000


async def list_folder_items(
    tm: BoxTokenManager,
    folder_id: str,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """List every item in a Box folder, following offset pagination.

    Args:
        tm (BoxTokenManager): token manager.
        folder_id (str): Box folder id ("0" is the root).
        limit (int): page size for each request.
    """
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = await box_get(
            tm,
            f"{tm.api_base}/folders/{folder_id}/items",
            params={
                "fields": LIST_FIELDS,
                "limit": limit,
                "offset": offset,
            },
        )
        entries = data.get("entries", [])
        out.extend(entries)
        offset += len(entries)
        if offset >= data.get("total_count", 0) or not entries:
            break
    return out


async def get_folder_info(tm: BoxTokenManager,
                          folder_id: str) -> dict[str, Any]:
    return await box_get(tm, f"{tm.api_base}/folders/{folder_id}")


async def download_file(tm: BoxTokenManager, file_id: str) -> bytes:
    return await box_get_bytes(tm, f"{tm.api_base}/files/{file_id}/content")


def download_file_stream(tm: BoxTokenManager,
                         file_id: str) -> AsyncIterator[bytes]:
    return box_get_stream(tm, f"{tm.api_base}/files/{file_id}/content")


async def search_content(
    tm: BoxTokenManager,
    query: str,
    ancestor_folder_id: str,
) -> tuple[list[dict[str, Any]], bool]:
    """Name+content search scoped to a folder subtree.

    Pages Box `/search` with `ancestor_folder_ids` scoping and
    `content_types=name,file_content` so the query matches file names and the
    server-indexed body text. Each returned item carries `path_collection`
    (its ancestor chain) for mount-relative path reconstruction.

    Args:
        tm (BoxTokenManager): token manager.
        query (str): literal search query.
        ancestor_folder_id (str): folder id scoping the search to a subtree.

    Returns:
        tuple[list[dict[str, Any]], bool]: matched file items and whether the
            result reached the 10,000-match ceiling (a truncated set is not a
            trustworthy superset of a full walk).
    """
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = await box_get(
            tm,
            f"{tm.api_base}/search",
            params={
                "query": query,
                "ancestor_folder_ids": ancestor_folder_id,
                "content_types": "name,file_content",
                "type": "file",
                "fields": SEARCH_FIELDS,
                "limit": SEARCH_PAGE,
                "offset": offset,
            },
        )
        entries = data.get("entries", [])
        out.extend(entries)
        offset += len(entries)
        if len(out) >= MAX_SEARCH_MATCHES:
            return out, True
        if offset >= data.get("total_count", 0) or not entries:
            return out, False


async def upload_new_file(tm: BoxTokenManager, parent_id: str, name: str,
                          data: bytes) -> dict[str, Any]:
    return await box_upload_multipart(
        tm,
        f"{tm.api_base}/files/content",
        {
            "name": name,
            "parent": {
                "id": parent_id
            }
        },
        name,
        data,
    )


async def upload_file_version(tm: BoxTokenManager, file_id: str, name: str,
                              data: bytes) -> dict[str, Any]:
    return await box_upload_multipart(
        tm,
        f"{tm.api_base}/files/{file_id}/content",
        {"name": name},
        name,
        data,
    )


async def create_folder(tm: BoxTokenManager, parent_id: str,
                        name: str) -> dict[str, Any]:
    return await box_post_json(tm, f"{tm.api_base}/folders", {
        "name": name,
        "parent": {
            "id": parent_id
        }
    })


async def delete_file(tm: BoxTokenManager, file_id: str) -> None:
    await box_delete(tm, f"{tm.api_base}/files/{file_id}")


async def delete_folder(tm: BoxTokenManager,
                        folder_id: str,
                        recursive: bool = True) -> None:
    await box_delete(tm,
                     f"{tm.api_base}/folders/{folder_id}",
                     params={"recursive": "true" if recursive else "false"})


async def update_file(tm: BoxTokenManager,
                      file_id: str,
                      name: str | None = None,
                      parent_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if parent_id is not None:
        body["parent"] = {"id": parent_id}
    return await box_put_json(tm, f"{tm.api_base}/files/{file_id}", body)


async def update_folder(tm: BoxTokenManager,
                        folder_id: str,
                        name: str | None = None,
                        parent_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if parent_id is not None:
        body["parent"] = {"id": parent_id}
    return await box_put_json(tm, f"{tm.api_base}/folders/{folder_id}", body)


async def copy_file(tm: BoxTokenManager,
                    file_id: str,
                    parent_id: str,
                    name: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"parent": {"id": parent_id}}
    if name is not None:
        body["name"] = name
    return await box_post_json(tm, f"{tm.api_base}/files/{file_id}/copy", body)


async def copy_folder(tm: BoxTokenManager,
                      folder_id: str,
                      parent_id: str,
                      name: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"parent": {"id": parent_id}}
    if name is not None:
        body["name"] = name
    return await box_post_json(tm, f"{tm.api_base}/folders/{folder_id}/copy",
                               body)
