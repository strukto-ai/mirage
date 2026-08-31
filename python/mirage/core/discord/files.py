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

from mirage.core.api.client import SessionArg, api_request, status_error
from mirage.utils.naming import fit_id_name
from mirage.utils.ranges import window_for
from mirage.utils.sanitize import path_safe_name


def file_blob_name(att: dict[str, Any]) -> str:
    """Construct a stable VFS filename for a Discord attachment.

    Args:
        att (dict): Discord attachment dict (with id, filename fields).

    Returns:
        str: VFS filename of shape ``<stem>__<att-id>.<ext>``. The stem
        keeps the original spelling, only ``/`` is replaced, and it is the
        only part trimmed to fit NAME_MAX -- the id and extension are what
        make the name resolve, so they are spent first.
    """
    raw_name = att.get("filename") or att.get("title") or "file"
    aid = str(att.get("id", ""))
    if "." in raw_name:
        stem, _, ext = raw_name.rpartition(".")
        return fit_id_name(path_safe_name(stem), aid, f".{ext}")
    return fit_id_name(path_safe_name(raw_name), aid)


async def download_file(url: str,
                        offset: int = 0,
                        size: int | None = None,
                        session: SessionArg = None) -> bytes:
    """Download a Discord-hosted file blob, optionally only a byte range.

    Discord CDN URLs (``cdn.discordapp.com`` for ``url``,
    ``media.discordapp.net`` for ``proxy_url``) are served without
    authentication so no token is needed. Takes the window rather than a
    prepared header so the answer can be checked against it: a CDN is
    free to ignore Range and reply 200 with the whole file, which
    ``window_if_unranged`` then trims.

    Args:
        url (str): Discord attachment URL (typically ``url`` from the
            attachment object).
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: raw file content.
    """
    data: bytes = await api_request("GET",
                                    url,
                                    error_of=status_error,
                                    read="bytes",
                                    window=window_for(offset, size),
                                    session=session)
    return data
