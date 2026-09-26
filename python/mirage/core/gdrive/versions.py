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

from mirage.core.google.client import (TokenManager, drive_base, google_get,
                                       google_get_bytes)
from mirage.utils.ranges import ByteWindow

REVISION_FIELDS = "nextPageToken,revisions(id,modifiedTime,md5Checksum,size)"


async def list_revisions(token_manager: TokenManager,
                         file_id: str) -> list[dict[str, Any]]:
    """List a file's revisions via the Drive Revisions API.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        list[dict]: revision metadata dicts, oldest first (API order).
    """
    revisions: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params: dict[str, str | int] = {"fields": REVISION_FIELDS}
        if page_token:
            params["pageToken"] = page_token
        url = f"{drive_base(token_manager)}/files/{file_id}/revisions"
        data = await google_get(token_manager, url, params=params)
        revisions.extend(data.get("revisions", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return revisions


async def download_revision(token_manager: TokenManager,
                            file_id: str,
                            revision_id: str,
                            window: ByteWindow | None = None) -> bytes:
    """Download a pinned revision's content (binary files only).

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        revision_id (str): revision ID to read.
        window (ByteWindow | None): the byte window to fetch, or None
            for all of it.
    """
    url = (f"{drive_base(token_manager)}/files/{file_id}"
           f"/revisions/{revision_id}?alt=media")
    return await google_get_bytes(token_manager, url, window)


async def capture_file_metadata(
        token_manager: TokenManager,
        file_id: str) -> tuple[str | None, str | None, str | None]:
    """Fetch a file's three version fields at read time.

    Returns the slots raw rather than a coalesced token, because the
    caller has to know which one it got: it verifies an md5 against the
    bytes it downloaded, and a token it cannot tell apart from a
    timestamp would be dropped for every binary file whose md5 Drive
    withholds. The head revision doubles as the pinnable revision.

    ``modifiedTime`` rides the same request and costs nothing. It is the
    only field a Drive shortcut carries, and without it such a file
    would stamp None on the read while stat answered a stamp.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        tuple[str | None, str | None, str | None]: the md5 checksum, the
        head revision id, and the modified stamp, each absent as None.
    """
    url = f"{drive_base(token_manager)}/files/{file_id}"
    item = await google_get(
        token_manager,
        url,
        params={
            "fields": "headRevisionId,md5Checksum,modifiedTime",
            "supportsAllDrives": "true",
        },
    )
    return (item.get("md5Checksum"), item.get("headRevisionId"),
            item.get("modifiedTime"))
