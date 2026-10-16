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
from collections.abc import AsyncGenerator
from enum import Enum
from typing import Any

from mirage.core.google.client import (
    TokenManager,
    drive_base,
    drive_upload_base,
    google_delete,
    google_get,
    google_get_bytes,
    google_get_stream,
    google_patch,
    google_post,
    google_resumable,
    google_send_bytes,
)
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow


class GoogleFileSuffix(str, Enum):
    """Rendered vfs filename suffixes; readdir emits only folders and these."""

    GDOC = ".gdoc.json"
    GSHEET = ".gsheet.json"
    GSLIDE = ".gslide.json"
    GMAIL = ".gmail.json"


# md5Checksum and headRevisionId are a file's token (`drive_fingerprint`).
FIELDS = (
    "nextPageToken,"
    "files(id,name,mimeType,driveId,size,quotaBytesUsed,"
    "createdTime,modifiedTime,md5Checksum,headRevisionId,"
    "owners,capabilities/canEdit,parents)"
)

# A search across every corpus is answered best-effort, so Drive reports
# whether it reached them all. The flag is only returned when asked for.
ALL_DRIVES_FIELDS = "incompleteSearch," + FIELDS

DRIVE_FIELDS = "nextPageToken,drives(id,name)"

MIME_TO_EXT = {
    "application/vnd.google-apps.document": GoogleFileSuffix.GDOC.value,
    "application/vnd.google-apps.spreadsheet": GoogleFileSuffix.GSHEET.value,
    "application/vnd.google-apps.presentation": GoogleFileSuffix.GSLIDE.value,
}


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
    limit: int | None = None,
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
        limit (int | None): stop once this many files are in hand and do
            not request another page. An emptiness probe wants one
            entry, and ``page_size`` alone cannot express that: it caps
            the page, not the walk, so a small page turned a listing of
            a large folder into many requests instead of fewer.

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
    return await _query_files(
        token_manager, " and ".join(parts), drive_id, page_size, limit
    )


async def list_children(
    token_manager: TokenManager,
    folder_ids: list[str],
    drive_id: str | None = None,
    page_size: int = 1000,
) -> list[dict[str, Any]]:
    """The untrashed children of several folders of one corpus, from one
    query (``'a' in parents or 'b' in parents``), in the order a listing
    of each folder returns them.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        folder_ids (list[str]): the folders.
        drive_id (str | None): their shared drive, None for My Drive.
        page_size (int): results per page.
    """
    parents = " or ".join(
        f"'{escape_query_value(folder_id)}' in parents"
        for folder_id in folder_ids
    )
    return await _query_files(
        token_manager, f"({parents}) and trashed=false", drive_id, page_size
    )


async def _query_files(
    token_manager: TokenManager,
    q: str,
    drive_id: str | None,
    page_size: int,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """The files a query names, newest first, a page at a time.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        q (str): the Drive query.
        drive_id (str | None): the shared drive searched, None for My
            Drive.
        page_size (int): results per page.
        limit (int | None): stop once this many files are in hand.
    """
    files: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "q": q,
            "fields": FIELDS,
            "pageSize": page_size if limit is None else min(page_size, limit),
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
        if limit is not None and len(files) >= limit:
            break
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
) -> tuple[list[dict[str, Any]], bool]:
    """List all files (no folder filter) via Drive API.

    Searches every corpus the account can reach, so a document that lives
    in a Shared Drive lists like one in My Drive. The alternative would be
    a mount that silently omits them while ``gdrive`` shows them for the
    same account.

    Drive answers an all-corpora search best-effort and sets
    ``incompleteSearch`` when it gave up on one, which is reported back
    rather than hidden: a caller that caches the listing must not cache a
    short one as if it were the whole directory.

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
        tuple[list[dict], bool]: file metadata dicts, and whether Drive
        searched every corpus it was asked for.
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
    complete = True
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "fields": ALL_DRIVES_FIELDS,
            "pageSize": page_size,
            "orderBy": "modifiedTime desc",
            # No driveId: allDrives is the union of My Drive and every
            # shared drive the account belongs to, so naming one would
            # contradict it.
            "corpora": "allDrives",
            "includeItemsFromAllDrives": "true",
            "supportsAllDrives": "true",
        }
        if q:
            params["q"] = q
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/files"
        data = await google_get(token_manager, url, params=params)
        files.extend(data.get("files", []))
        if data.get("incompleteSearch"):
            complete = False
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files, complete


async def search_files(
    token_manager: TokenManager,
    text: str,
    parent_ids: list[str],
    mime_type: str | None = None,
    page_size: int = 1000,
) -> tuple[list[str], bool]:
    """Ids of the files in ``parent_ids`` Drive full-text search names.

    Drive sorts no ``fullText`` query, so none is asked for.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        text (str): the text searched for.
        parent_ids (list[str]): the folders whose children are searched,
            or none for every folder.
        mime_type (str | None): the one MIME type searched.
        page_size (int): results per page.

    Returns:
        tuple[list[str], bool]: the file ids, and whether Drive searched
        every corpus it was asked for.
    """
    parts = [
        f"fullText contains '{escape_query_value(text)}'",
        "trashed=false",
    ]
    if parent_ids:
        parents = " or ".join(
            f"'{escape_query_value(p)}' in parents" for p in parent_ids
        )
        parts.append(f"({parents})")
    if mime_type:
        parts.append(f"mimeType='{mime_type}'")
    q = " and ".join(parts)
    ids: list[str] = []
    complete = True
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {
            "q": q,
            "fields": "nextPageToken,incompleteSearch,files(id)",
            "pageSize": page_size,
            "corpora": "allDrives",
            "includeItemsFromAllDrives": "true",
            "supportsAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/files"
        data = await google_get(token_manager, url, params=params)
        ids.extend(f["id"] for f in data.get("files", []))
        if data.get("incompleteSearch"):
            complete = False
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return ids, complete


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
    window: ByteWindow | None = None,
) -> bytes:
    """Download a regular file from Drive.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        window (ByteWindow | None): the byte window to fetch, or None
            for all of it.

    Returns:
        bytes: file content.
    """
    return await google_get_bytes(
        token_manager, _media_url(token_manager, file_id), window
    )


def download_file_stream(
    token_manager: TokenManager, file_id: str
) -> AsyncGenerator[bytes, None]:
    """Stream a regular file from Drive as it downloads.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
    """
    return google_get_stream(token_manager, _media_url(token_manager, file_id))


def _media_url(token_manager: TokenManager, file_id: str) -> str:
    return (
        f"{drive_base(token_manager)}/files/{file_id}"
        "?alt=media&supportsAllDrives=true"
    )


FOLDER_MIME = "application/vnd.google-apps.folder"
ITEM_FIELDS = (
    "id,name,mimeType,driveId,size,quotaBytesUsed,"
    "createdTime,modifiedTime,md5Checksum,headRevisionId,parents,owners,trashed"
)
DEFAULT_UPLOAD_MIME = "application/octet-stream"


def _multipart_related(
    metadata: dict[str, Any], data: bytes, mime_type: str
) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    meta = json.dumps(metadata).encode()
    body = (
        (
            f"--{boundary}\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        ).encode()
        + meta
        + f"\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n".encode()
        + data
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return body, f"multipart/related; boundary={boundary}"


# What a change read names of each file: enough to place it on a Drive
# or app mount and to tell a new file from an edited one.
CHANGE_FIELDS = (
    "nextPageToken,newStartPageToken,changes(changeType,fileId,removed,"
    "file(id,name,mimeType,driveId,createdTime,modifiedTime,parents,"
    "owners,trashed))"
)


async def start_page_token(token_manager: TokenManager) -> str:
    """The changes page token at the present, which lists nothing.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
    """
    url = f"{drive_base(token_manager)}/changes/startPageToken"
    data = await google_get(
        token_manager, url, params={"supportsAllDrives": "true"}
    )
    return str(data["startPageToken"])


async def list_changes(
    token_manager: TokenManager, page_token: str
) -> tuple[list[dict[str, Any]], str]:
    """Every change since ``page_token`` across the account's drives,
    and the token the next read starts from.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        page_token (str): Where the last read ended.
    """
    url = f"{drive_base(token_manager)}/changes"
    found: list[dict[str, Any]] = []
    token = page_token
    while True:
        data = await google_get(
            token_manager,
            url,
            params={
                "pageToken": token,
                "fields": CHANGE_FIELDS,
                "pageSize": 1000,
                "includeItemsFromAllDrives": "true",
                "supportsAllDrives": "true",
            },
        )
        rows = data.get("changes")
        if isinstance(rows, list):
            found.extend(r for r in rows if isinstance(r, dict))
        if data.get("newStartPageToken"):
            return found, str(data["newStartPageToken"])
        token = str(data["nextPageToken"])


async def get_file(
    token_manager: TokenManager, file_id: str
) -> dict[str, Any]:
    """Fetch a single file's metadata.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        dict: file metadata.
    """
    url = f"{drive_base(token_manager)}/files/{file_id}"
    return await google_get(
        token_manager,
        url,
        params={
            "fields": ITEM_FIELDS,
            "supportsAllDrives": "true",
        },
    )


async def create_folder(
    token_manager: TokenManager, name: str, parent_id: str
) -> dict[str, Any]:
    """Create a Drive folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        name (str): folder name.
        parent_id (str): parent folder ID.

    Returns:
        dict: created folder metadata.
    """
    url = (
        f"{drive_base(token_manager)}/files"
        f"?supportsAllDrives=true&fields={ITEM_FIELDS}"
    )
    return await google_post(
        token_manager,
        url,
        {
            "name": name,
            "mimeType": FOLDER_MIME,
            "parents": [parent_id],
        },
    )


async def upload_file(
    token_manager: TokenManager,
    name: str,
    parent_id: str,
    data: bytes | ByteSpool,
    mime_type: str = DEFAULT_UPLOAD_MIME,
) -> dict[str, Any]:
    """Create a Drive file with content via a multipart upload.

    Large spooled payloads use the resumable protocol.

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
    if isinstance(data, ByteSpool):
        if data.size > 4 * 1024 * 1024:
            return await google_resumable(
                token_manager,
                "POST",
                f"{drive_upload_base(token_manager)}/files",
                metadata,
                data,
                mime_type,
                {"supportsAllDrives": "true", "fields": ITEM_FIELDS},
            )
        data = await data.read(0, data.size)

    body, content_type = _multipart_related(metadata, data, mime_type)
    url = f"{drive_upload_base(token_manager)}/files"
    return await google_send_bytes(
        token_manager,
        "POST",
        url,
        body,
        content_type,
        params={
            "uploadType": "multipart",
            "supportsAllDrives": "true",
            "fields": ITEM_FIELDS,
        },
    )


async def update_file_content(
    token_manager: TokenManager,
    file_id: str,
    data: bytes | ByteSpool,
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
    if isinstance(data, ByteSpool):
        if data.size > 4 * 1024 * 1024:
            return await google_resumable(
                token_manager,
                "PATCH",
                f"{drive_upload_base(token_manager)}/files/{file_id}",
                {},
                data,
                mime_type,
                {"supportsAllDrives": "true", "fields": ITEM_FIELDS},
            )
        data = await data.read(0, data.size)
    url = f"{drive_upload_base(token_manager)}/files/{file_id}"
    return await google_send_bytes(
        token_manager,
        "PATCH",
        url,
        data,
        mime_type,
        params={
            "uploadType": "media",
            "supportsAllDrives": "true",
            "fields": ITEM_FIELDS,
        },
    )


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


async def copy_file(
    token_manager: TokenManager, file_id: str, name: str, parent_id: str
) -> dict[str, Any]:
    """Copy a Drive file (regular or google-apps) into a parent folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): source file ID.
        name (str): destination file name.
        parent_id (str): destination parent folder ID.

    Returns:
        dict: created copy's metadata.
    """
    url = (
        f"{drive_base(token_manager)}/files/{file_id}/copy"
        f"?supportsAllDrives=true&fields={ITEM_FIELDS}"
    )
    return await google_post(
        token_manager,
        url,
        {
            "name": name,
            "parents": [parent_id],
        },
    )
