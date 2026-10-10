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

from mirage.utils.naming import file_id_name, make_id_name


def channel_dirname(ch: dict[str, Any]) -> str:
    """Compute the VFS dirname for a channel, of the form `name__C123`."""
    return make_id_name(
        ch.get("name", ch.get("id", "unknown")),
        ch["id"],
        path_safe=True,
    )


def dm_dirname(dm: dict[str, Any], user_map: dict[str, str]) -> str:
    """Compute the VFS dirname for a DM, of the form `username__D123`.

    Args:
        dm (dict): DM channel dict with id and user fields.
        user_map (dict[str, str]): user_id -> name lookup.

    Returns:
        str: dirname; falls back to the user id when not in user_map.
    """
    user_id = dm.get("user", "")
    display = user_map.get(user_id, user_id)
    return make_id_name(display, dm["id"], path_safe=True)


def user_filename(u: dict[str, Any]) -> str:
    """Compute the VFS filename for a user, of the form `name__U123.json`."""
    name = u.get("name", u.get("id", "unknown"))
    return make_id_name(name, u["id"], path_safe=True, suffix=".json")


def file_blob_name(file_meta: dict[str, Any]) -> str:
    """Construct a stable VFS filename for a Slack file metadata dict.

    Args:
        file_meta (dict): Slack file dict (with id, name/title fields).

    Returns:
        str: VFS filename of shape `<stem>__<F-id>.<ext>`, named after
        ``name`` and else ``title`` (see ``file_id_name``).
    """
    return file_id_name(
        file_meta.get("id", ""), file_meta.get("name"), file_meta.get("title")
    )
