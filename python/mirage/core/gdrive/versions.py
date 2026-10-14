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

from collections.abc import AsyncGenerator

from mirage.core.google.client import (
    TokenManager,
    drive_base,
    google_get,
    google_get_bytes,
    google_get_stream,
)
from mirage.utils.ranges import ByteWindow


async def download_revision(
    token_manager: TokenManager,
    file_id: str,
    revision_id: str,
    window: ByteWindow | None = None,
) -> bytes:
    """Download a pinned revision's content (binary files only).

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        revision_id (str): revision ID to read.
        window (ByteWindow | None): the byte window to fetch, or None
            for all of it.
    """
    return await google_get_bytes(
        token_manager,
        _revision_url(token_manager, file_id, revision_id),
        window,
    )


def download_revision_stream(
    token_manager: TokenManager, file_id: str, revision_id: str
) -> AsyncGenerator[bytes, None]:
    """Stream a pinned revision's content as it downloads.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        revision_id (str): revision ID to read.
    """
    return google_get_stream(
        token_manager, _revision_url(token_manager, file_id, revision_id)
    )


def _revision_url(
    token_manager: TokenManager, file_id: str, revision_id: str
) -> str:
    return (
        f"{drive_base(token_manager)}/files/{file_id}"
        f"/revisions/{revision_id}?alt=media"
    )


async def capture_file_metadata(
    token_manager: TokenManager, file_id: str
) -> tuple[str | None, str | None]:
    """Fetch a file's md5 and head revision at read time.

    Returned raw rather than coalesced, because the caller checks the md5
    against the bytes it downloads. The head revision doubles as the
    pinnable revision.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.

    Returns:
        tuple[str | None, str | None]: the md5 checksum and the head
        revision id, each absent as None.
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
    return item.get("md5Checksum"), item.get("headRevisionId")
