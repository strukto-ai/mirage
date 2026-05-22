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

import aiohttp

from mirage.resource.secrets import reveal_secret
from mirage.resource.slack.config import SlackConfig
from mirage.utils.sanitize import path_safe_name


def file_blob_name(file_meta: dict) -> str:
    """Construct a stable VFS filename for a Slack file metadata dict.

    Args:
        file_meta (dict): Slack file dict (with id, name/title fields).

    Returns:
        str: VFS filename of shape `<stem>__<F-id>.<ext>`. The stem keeps
        the original spelling, only ``/`` is replaced.
    """
    raw_name = file_meta.get("name") or file_meta.get("title") or "file"
    fid = file_meta.get("id", "")
    if "." in raw_name:
        stem, _, ext = raw_name.rpartition(".")
        return f"{path_safe_name(stem)}__{fid}.{ext}"
    return f"{path_safe_name(raw_name)}__{fid}"


async def download_file(config: SlackConfig, url: str) -> bytes:
    """Download a Slack-hosted file blob.

    Args:
        config (SlackConfig): Slack credentials.
        url (str): Slack file URL (typically url_private_download).

    Returns:
        bytes: raw file content.
    """
    headers = {"Authorization": f"Bearer {reveal_secret(config.token)}"}
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.read()
