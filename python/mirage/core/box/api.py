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

import aiohttp

from mirage.core.box._client import (BoxApiError, BoxTokenManager,
                                     box_auth_headers, box_delete, box_get,
                                     box_get_bytes, box_get_stream,
                                     box_post_json, box_put_json,
                                     box_upload_multipart)

LIST_FIELDS = "id,name,type,size,modified_at,etag,sha1,parent"


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


async def search_items(
    tm: BoxTokenManager,
    query: str,
    limit: int = 100,
    item_type: str | None = None,
) -> list[dict[str, Any]]:
    """Search Box by name/content substring.

    Args:
        tm (BoxTokenManager): token manager.
        query (str): search query.
        limit (int): maximum results.
        item_type (str | None): "file" or "folder" to restrict the type.
    """
    params: dict[str, Any] = {
        "query": query,
        "fields": LIST_FIELDS,
        "limit": limit,
    }
    if item_type is not None:
        params["type"] = item_type
    data = await box_get(tm, f"{tm.api_base}/search", params=params)
    entries: list[dict[str, Any]] = data.get("entries", [])
    return entries


async def get_extracted_text(tm: BoxTokenManager, file_id: str) -> str:
    """Fetch the auto-extracted plain-text representation of a Box file.

    Box transcodes .docx / .xlsx / .pptx (and many other formats)
    server-side into plain text, exposed via the representations API.
    Returns "" if the representation isn't ready or doesn't exist for
    this file type.

    Args:
        tm (BoxTokenManager): token manager.
        file_id (str): Box file id.
    """
    headers = await box_auth_headers(tm)
    meta_url = f"{tm.api_base}/files/{file_id}?fields=representations"
    async with aiohttp.ClientSession() as session:
        async with session.get(meta_url,
                               headers={
                                   **headers, "X-Rep-Hints": "[extracted_text]"
                               }) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(
                    f"Box GET extracted_text meta -> {resp.status} {text}",
                    resp.status,
                )
            data = await resp.json()
        entries = (data.get("representations") or {}).get("entries") or []
        entry = next(
            (e
             for e in entries if e.get("representation") == "extracted_text"),
            None)
        if entry is None:
            return ""
        if (entry.get("status") or {}).get("state") != "success":
            return ""
        tmpl = (entry.get("content") or {}).get("url_template")
        if not tmpl:
            return ""
        content_url = tmpl.replace("{+asset_path}", "")
        async with session.get(content_url, headers=headers) as resp:
            if resp.status >= 400:
                return ""
            return await resp.text()


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
