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

import aiohttp

from mirage.utils.sanitize import path_safe_name


def file_blob_name(att: dict[str, Any]) -> str:
    """Construct a stable VFS filename for a Discord attachment.

    Args:
        att (dict): Discord attachment dict (with id, filename fields).

    Returns:
        str: VFS filename of shape ``<stem>__<att-id>.<ext>``. The stem
        keeps the original spelling, only ``/`` is replaced.
    """
    raw_name = att.get("filename") or att.get("title") or "file"
    aid = str(att.get("id", ""))
    if "." in raw_name:
        stem, _, ext = raw_name.rpartition(".")
        return f"{path_safe_name(stem)}__{aid}.{ext}"
    return f"{path_safe_name(raw_name)}__{aid}"


async def download_file(url: str) -> bytes:
    """Download a Discord-hosted file blob.

    Discord CDN URLs (``cdn.discordapp.com`` for ``url``,
    ``media.discordapp.net`` for ``proxy_url``) are served without
    authentication so no token is needed.

    Args:
        url (str): Discord attachment URL (typically ``url`` from the
            attachment object).

    Returns:
        bytes: raw file content.
    """
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            return await resp.read()
