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
from mirage.core.slack.config import SlackConfig
from mirage.resource.secrets import reveal_secret
from mirage.utils.naming import fit_id_name
from mirage.utils.ranges import window_for
from mirage.utils.sanitize import path_safe_name


def file_blob_name(file_meta: dict[str, Any]) -> str:
    """Construct a stable VFS filename for a Slack file metadata dict.

    Args:
        file_meta (dict): Slack file dict (with id, name/title fields).

    Returns:
        str: VFS filename of shape `<stem>__<F-id>.<ext>`. The stem keeps
        the original spelling, only ``/`` is replaced, and it is the only
        part trimmed to fit NAME_MAX -- the id and extension are what make
        the name resolve, so they are spent first.
    """
    raw_name = file_meta.get("name") or file_meta.get("title") or "file"
    fid = file_meta.get("id", "")
    if "." in raw_name:
        stem, _, ext = raw_name.rpartition(".")
        return fit_id_name(path_safe_name(stem), fid, f".{ext}")
    return fit_id_name(path_safe_name(raw_name), fid)


async def download_file(config: SlackConfig,
                        url: str,
                        offset: int = 0,
                        size: int | None = None,
                        session: SessionArg = None) -> bytes:
    """Download a Slack-hosted file blob, optionally only a byte range.

    Takes the window rather than a prepared header so the answer can be
    checked against it: Slack serves files from a CDN, and a server is
    free to ignore Range and reply 200 with the whole file, which
    ``window_if_unranged`` then trims.

    Args:
        config (SlackConfig): Slack credentials.
        url (str): Slack file URL (typically url_private_download).
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: raw file content.
    """
    headers = {"Authorization": f"Bearer {reveal_secret(config.token)}"}
    data: bytes = await api_request("GET",
                                    url,
                                    error_of=status_error,
                                    headers=headers,
                                    read="bytes",
                                    window=window_for(offset, size),
                                    session=session)
    return data
