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

import json
import uuid
from enum import Enum
from typing import Any

from mirage.core.google._client import (TokenManager, drive_base,
                                        drive_upload_base, google_delete,
                                        google_get, google_get_bytes,
                                        google_patch, google_post,
                                        google_send_bytes)


class GoogleFileSuffix(str, Enum):
    """Rendered vfs filename suffixes; readdir emits only folders and these."""
    GDOC = ".gdoc.json"
    GSHEET = ".gsheet.json"
    GSLIDE = ".gslide.json"
    GMAIL = ".gmail.json"


FIELDS = ("nextPageToken,"
          "files(id,name,mimeType,driveId,size,quotaBytesUsed,"
          "createdTime,modifiedTime,"
          "owners,capabilities/canEdit,parents)")

DRIVE_FIELDS = "nextPageToken,drives(id,name)"

MIME_TO_EXT = {
    "application/vnd.google-apps.document": GoogleFileSuffix.GDOC.value,
    "application/vnd.google-apps.spreadsheet": GoogleFileSuffix.GSHEET.value,
    "application/vnd.google-apps.presentation": GoogleFileSuffix.GSLIDE.value,
}

WORKSPACE_MIMES = set(MIME_TO_EXT.keys())


def escape_query_value(value: str) -> str:
    """Escape a value for a Drive API query string literal.

    Args:
        value (str): raw name or literal.
    """
    return value.replace("\\", "\\\\").replace("'", "\\'")


async def list_files(
    token_manager: TokenManager,
    folder_id: str = "root",
    drive_id: str | None = None,
    mime_type: str | None = None,
    trashed: bool = False,
    page_size: int = 1000,
    modified_after: str | None = None,
    modified_before: str | None = None,
    name: str | None = None,
) -> list[dict[str, Any]]:
    """List files via Drive API.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        folder_id (str): parent folder ID or "root".
        drive_id (str | None): shared drive ID when listing inside a shared
            drive.
        mime_type (str | None): filter by MIME type.
        trashed (bool): include trashed files.
        page_size (int): results per page.
        modified_after (str | None): RFC3339 timestamp; include only files
            with modifiedTime >= this.
        modified_before (str | None): RFC3339 timestamp; include only files
            with modifiedTime < this.
        name (str | None): exact file name filter.

    Returns:
        list[dict]: file metadata dicts.
    """
    parts = [f"'{folder_id}' in parents"]
    if name is not None:
        parts.append(f"name='{escape_query_value(name)}'")
    if mime_type:
        parts.append(f"mimeType='{mime_type}'")
    if not trashed:
        parts.append("trashed=false")
    if modified_after:
        parts.append(f"modifiedTime >= '{modified_after}'")
    if modified_before:
        parts.append(f"modifiedTime < '{modified_before}'")
    q = " and ".join(parts)
    files: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "q": q,
            "fields": FIELDS,
            "pageSize": page_size,
            "orderBy": "modifiedTime desc",
        }
        if drive_id:
            params["corpora"] = "drive"
            params["driveId"] = drive_id
            params["includeItemsFromAllDrives"] = "true"
            params["supportsAllDrives"] = "true"
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/files"
        data = await google_get(token_manager, url, params=params)
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


async def list_shared_drives(
    token_manager: TokenManager,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """List shared drives visible to the authenticated user.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        page_size (int): results per page.

    Returns:
        list[dict]: shared drive metadata dicts.
    """
    drives: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "fields": DRIVE_FIELDS,
            "pageSize": page_size,
        }
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/drives"
        data = await google_get(token_manager, url, params=params)
        drives.extend(data.get("drives", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return drives


async def list_all_files(
    token_manager: TokenManager,
    mime_type: str | None = None,
    trashed: bool = False,
    page_size: int = 1000,
    modified_after: str | None = None,
    modified_before: str | None = None,
) -> list[dict[str, Any]]:
    """List all files (no folder filter) via Drive API.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        mime_type (str | None): filter by MIME type.
        trashed (bool): include trashed files.
        page_size (int): results per page.
        modified_after (str | None): RFC3339 timestamp; include only files
            with modifiedTime >= this.
        modified_before (str | None): RFC3339 timestamp; include only files
            with modifiedTime < this.

    Returns:
        list[dict]: file metadata dicts.
    """
    parts = []
    if mime_type:
        parts.append(f"mimeType='{mime_type}'")
    if not trashed:
        parts.append("trashed=false")
    if modified_after:
        parts.append(f"modifiedTime >= '{modified_after}'")
    if modified_before:
        parts.append(f"modifiedTime < '{modified_before}'")
    q = " and ".join(parts) if parts else None
    files: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "fields": FIELDS,
            "pageSize": page_size,
            "orderBy": "modifiedTime desc",
        }
        if q:
            params["q"] = q
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/files"
        data = await google_get(token_manager, url, params=params)
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


async def delete_file(
    token_manager: TokenManager,
    file_id: str,
) -> None:
    """Permanently delete a Drive file.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
    """
    url = f"{drive_base(token_manager)}/files/{file_id}?supportsAllDrives=true"
    await google_delete(token_manager, url)


async def download_file(
    token_manager: TokenManager,
    file_id: str,
) -> bytes:
    """Download a regular file from Drive.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        bytes: file content.
    """
    url = (f"{drive_base(token_manager)}/files/{file_id}"
           "?alt=media&supportsAllDrives=true")
    return await google_get_bytes(token_manager, url)


FOLDER_MIME = "application/vnd.google-apps.folder"
ITEM_FIELDS = ("id,name,mimeType,driveId,size,quotaBytesUsed,"
               "createdTime,modifiedTime,parents")
DEFAULT_UPLOAD_MIME = "application/octet-stream"


def _multipart_related(metadata: dict[str, Any], data: bytes,
                       mime_type: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    meta = json.dumps(metadata).encode()
    body = (
        (f"--{boundary}\r\n"
         "Content-Type: application/json; charset=UTF-8\r\n\r\n").encode() +
        meta + f"\r\n--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n\r\n".encode() + data +
        f"\r\n--{boundary}--\r\n".encode())
    return body, f"multipart/related; boundary={boundary}"


async def get_file(token_manager: TokenManager,
                   file_id: str) -> dict[str, Any]:
    """Fetch a single file's metadata.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        dict: file metadata.
    """
    url = f"{drive_base(token_manager)}/files/{file_id}"
    return await google_get(token_manager,
                            url,
                            params={
                                "fields": ITEM_FIELDS,
                                "supportsAllDrives": "true",
                            })


async def create_folder(token_manager: TokenManager, name: str,
                        parent_id: str) -> dict[str, Any]:
    """Create a Drive folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        name (str): folder name.
        parent_id (str): parent folder ID.

    Returns:
        dict: created folder metadata.
    """
    url = (f"{drive_base(token_manager)}/files"
           f"?supportsAllDrives=true&fields={ITEM_FIELDS}")
    return await google_post(token_manager, url, {
        "name": name,
        "mimeType": FOLDER_MIME,
        "parents": [parent_id],
    })


async def upload_file(
    token_manager: TokenManager,
    name: str,
    parent_id: str,
    data: bytes,
    mime_type: str = DEFAULT_UPLOAD_MIME,
) -> dict[str, Any]:
    """Create a Drive file with content via a multipart upload.

    Multipart uploads cap at 5 MiB on the real API; larger payloads need
    the resumable protocol, which mirage does not use yet.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        name (str): file name.
        parent_id (str): parent folder ID.
        data (bytes): file content.
        mime_type (str): content MIME type.

    Returns:
        dict: created file metadata.
    """
    metadata = {"name": name, "parents": [parent_id]}
    body, content_type = _multipart_related(metadata, data, mime_type)
    url = f"{drive_upload_base(token_manager)}/files"
    return await google_send_bytes(token_manager,
                                   "POST",
                                   url,
                                   body,
                                   content_type,
                                   params={
                                       "uploadType": "multipart",
                                       "supportsAllDrives": "true",
                                       "fields": ITEM_FIELDS,
                                   })


async def update_file_content(
    token_manager: TokenManager,
    file_id: str,
    data: bytes,
    mime_type: str = DEFAULT_UPLOAD_MIME,
) -> dict[str, Any]:
    """Replace an existing Drive file's content.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        data (bytes): new content.
        mime_type (str): content MIME type.

    Returns:
        dict: updated file metadata.
    """
    url = f"{drive_upload_base(token_manager)}/files/{file_id}"
    return await google_send_bytes(token_manager,
                                   "PATCH",
                                   url,
                                   data,
                                   mime_type,
                                   params={
                                       "uploadType": "media",
                                       "supportsAllDrives": "true",
                                       "fields": ITEM_FIELDS,
                                   })


async def patch_file(
    token_manager: TokenManager,
    file_id: str,
    body: dict[str, Any] | None = None,
    add_parents: str | None = None,
    remove_parents: str | None = None,
) -> dict[str, Any]:
    """Patch file metadata (rename and/or move between parents).

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        body (dict | None): metadata fields to set (e.g. ``{"name": ...}``).
        add_parents (str | None): parent folder ID to add.
        remove_parents (str | None): parent folder ID to remove.

    Returns:
        dict: updated file metadata.
    """
    params: dict[str, str] = {
        "supportsAllDrives": "true",
        "fields": ITEM_FIELDS,
    }
    if add_parents:
        params["addParents"] = add_parents
    if remove_parents:
        params["removeParents"] = remove_parents
    url = f"{drive_base(token_manager)}/files/{file_id}"
    return await google_patch(token_manager, url, body or {}, params=params)


async def copy_file(token_manager: TokenManager, file_id: str, name: str,
                    parent_id: str) -> dict[str, Any]:
    """Copy a Drive file (regular or google-apps) into a parent folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): source file ID.
        name (str): destination file name.
        parent_id (str): destination parent folder ID.

    Returns:
        dict: created copy's metadata.
    """
    url = (f"{drive_base(token_manager)}/files/{file_id}/copy"
           f"?supportsAllDrives=true&fields={ITEM_FIELDS}")
    return await google_post(token_manager, url, {
        "name": name,
        "parents": [parent_id],
    })
