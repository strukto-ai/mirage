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

from mirage.core.google._client import (TokenManager, drive_base, google_get,
                                        google_get_bytes)

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


async def download_revision(token_manager: TokenManager, file_id: str,
                            revision_id: str) -> bytes:
    """Download a pinned revision's content (binary files only).

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        revision_id (str): revision ID to read.
    """
    url = (f"{drive_base(token_manager)}/files/{file_id}"
           f"/revisions/{revision_id}?alt=media")
    return await google_get_bytes(token_manager, url)


async def capture_file_metadata(token_manager: TokenManager,
                                file_id: str) -> tuple[str | None, str | None]:
    """Fetch the (fingerprint, revision) pair for a file at read time.

    The head revision ID doubles as the pinnable revision; the MD5 checksum
    is the content fingerprint (falls back to the head revision ID for
    types without one).

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
    """
    url = f"{drive_base(token_manager)}/files/{file_id}"
    item = await google_get(
        token_manager,
        url,
        params={
            "fields": "headRevisionId,md5Checksum",
            "supportsAllDrives": "true",
        },
    )
    revision = item.get("headRevisionId")
    fingerprint = item.get("md5Checksum") or revision
    return fingerprint, revision
