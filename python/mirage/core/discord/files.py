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
from typing import Any

from mirage.accessor.discord import DiscordAccessor
from mirage.core.api.client import api_request, api_stream, status_error
from mirage.utils.naming import file_id_name
from mirage.utils.ranges import window_for


def is_listed(att: dict[str, Any]) -> bool:
    """Whether a day's ``files`` directory lists an attachment.

    Tombstoned (deleted) and access-restricted attachment payloads
    carry an id but no download URL and no byte size; read() ENOENTs on
    them, so listing them would surface phantom files with unknown
    sizes. Mirrors the slack guard.

    Args:
        att (dict): Discord attachment dict.
    """
    return (
        bool(att.get("id"))
        and bool(att.get("url"))
        and (att.get("size") is not None)
    )


def file_blob_name(att: dict[str, Any]) -> str:
    """Construct a stable VFS filename for a Discord attachment.

    Args:
        att (dict): Discord attachment dict (with id, filename fields).

    Returns:
        str: VFS filename of shape ``<stem>__<att-id>.<ext>``, named after
        ``filename`` and else ``title`` (see ``file_id_name``).
    """
    return file_id_name(
        str(att.get("id", "")), att.get("filename"), att.get("title")
    )


async def download_file(
    accessor: DiscordAccessor,
    url: str,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Download a Discord-hosted file blob, optionally only a byte range.

    Discord CDN URLs (``cdn.discordapp.com`` for ``url``,
    ``media.discordapp.net`` for ``proxy_url``) are served without
    authentication so no token is needed. Takes the window rather than a
    prepared header so the answer can be checked against it: a CDN is
    free to ignore Range and reply 200 with the whole file, which
    ``window_if_unranged`` then trims.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        url (str): Discord attachment URL (typically ``url`` from the
            attachment object).
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.

    Returns:
        bytes: raw file content.
    """
    data: bytes = await api_request(
        "GET",
        url,
        error_of=status_error,
        read="bytes",
        window=window_for(offset, size),
        session=accessor.pool,
    )
    return data


def download_file_stream(
    accessor: DiscordAccessor, url: str
) -> AsyncGenerator[bytes, None]:
    """Stream an attachment with bounded reads and response cleanup.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        url (str): attachment download URL.
    """
    return api_stream(url, error_of=status_error, session=accessor.pool)
