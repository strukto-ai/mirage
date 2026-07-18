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

from enum import Enum
from typing import Any

from mirage.core.google._client import (DRIVE_API_BASE, TokenManager,
                                        google_delete, google_get,
                                        google_get_bytes)


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


async def list_files(
    token_manager: TokenManager,
    folder_id: str = "root",
    drive_id: str | None = None,
    mime_type: str | None = None,
    trashed: bool = False,
    page_size: int = 1000,
    modified_after: str | None = None,
    modified_before: str | None = None,
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

    Returns:
        list[dict]: file metadata dicts.
    """
    parts = [f"'{folder_id}' in parents"]
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
        url = f"{DRIVE_API_BASE}/files"
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
        url = f"{DRIVE_API_BASE}/drives"
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
        url = f"{DRIVE_API_BASE}/files"
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
    url = f"{DRIVE_API_BASE}/files/{file_id}?supportsAllDrives=true"
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
    url = (f"{DRIVE_API_BASE}/files/{file_id}"
           "?alt=media&supportsAllDrives=true")
    return await google_get_bytes(token_manager, url)
