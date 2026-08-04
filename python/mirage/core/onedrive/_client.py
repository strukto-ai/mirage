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

from functools import partial
from urllib.parse import quote

from mirage.accessor.onedrive import OneDriveConfig
# yapf: disable
from mirage.core.msgraph._client import (MAX_BACKOFF, RETRY_STATUSES,
                                         GraphError, graph_delete, graph_get,
                                         graph_get_bytes, graph_list,
                                         graph_patch, graph_post,
                                         graph_post_monitor, graph_put_bytes,
                                         graph_stream, headers, id_segment,
                                         new_session, poll_monitor,
                                         upload_chunk)
# yapf: enable
from mirage.core.msgraph.config import graph_api
from mirage.core.msgraph.drive_ops import DriveLoc
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

__all__ = [
    "graph_api",
    "drive_loc",
    "MAX_BACKOFF",
    "RETRY_STATUSES",
    "GraphError",
    "drive_base",
    "drive_ref_path",
    "graph_delete",
    "graph_get",
    "graph_get_bytes",
    "graph_list",
    "graph_patch",
    "graph_post",
    "graph_post_monitor",
    "graph_put_bytes",
    "graph_stream",
    "headers",
    "id_segment",
    "item_url",
    "new_session",
    "poll_monitor",
    "split_path",
    "upload_chunk",
]


def split_path(path: PathSpec) -> tuple[str, str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    return prefix, path.resource_path


def drive_base(config: OneDriveConfig) -> str:
    """The drive this mount addresses, as a Graph URL prefix.

    Exactly one target may be named (``OneDriveConfig`` enforces it), so
    the arms are alternatives rather than a precedence chain. Naming none
    means the signed-in user's own drive, which is the only form that
    works under delegated auth with no extra identifiers.

    Each identifier is escaped as a single path segment. A guest user's
    UPN carries ``#EXT#``, and interpolated raw that ``#`` would open a
    URL fragment and send a truncated path.

    Args:
        config (OneDriveConfig): mount config.
    """
    api = graph_api(config)
    if config.drive_id:
        return f"{api}/drives/{id_segment(config.drive_id)}"
    if config.site_id:
        return f"{api}/sites/{id_segment(config.site_id)}/drive"
    if config.group_id:
        return f"{api}/groups/{id_segment(config.group_id)}/drive"
    if config.user_id:
        return f"{api}/users/{id_segment(config.user_id)}/drive"
    return f"{api}/me/drive"


def _full_path(config: OneDriveConfig, path: str) -> str:
    p = path.strip("/")
    prefix = (config.key_prefix or "").strip("/")
    if prefix and p:
        return f"{prefix}/{p}"
    return prefix or p


def item_url(config: OneDriveConfig, path: str, action: str = "") -> str:
    base = drive_base(config)
    full = _full_path(config, path)
    if not full:
        return f"{base}/root{action}"
    stem = f"{base}/root:/{quote(full, safe='/')}"
    if action:
        return f"{stem}:{action}"
    return stem


def drive_ref_path(config: OneDriveConfig, folder: str = "") -> str:
    # `folder` is resource-relative; the key_prefix must apply here exactly
    # like item_url, or copy/rename destinations land at the drive root.
    base = drive_base(config)[len(graph_api(config)):]
    full = _full_path(config, folder)
    if full:
        return f"{base}/root:/{quote(full, safe='/')}"
    return f"{base}/root:"


def drive_loc(config: OneDriveConfig, stripped: str) -> DriveLoc:
    return DriveLoc(drive="",
                    path=stripped,
                    virt=stripped,
                    url=partial(item_url, config),
                    ref=partial(drive_ref_path, config))
