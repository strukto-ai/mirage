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

from enum import Enum

from mirage.cache.index.config import IndexEntry
from mirage.utils.naming import make_id_name


class SlackResourceType(str, Enum):
    CHANNEL = "slack/channel"
    DM = "slack/dm"
    USER = "slack/user"
    HISTORY = "slack/history"
    VIRTUAL_ROOT = "slack/virtual_root"


class SlackIndexEntry(IndexEntry):
    """Slack resource index entry."""

    @classmethod
    def channel(cls, ch: dict) -> "SlackIndexEntry":
        """Build entry from Slack channel API response.

        Example::

            SlackIndexEntry.channel({
                "id": "C123", "name": "general",
                "created": 1700000000,
            })
            # vfs_name → "general__C123"
        """
        return cls(
            id=ch["id"],
            name=ch.get("name", ""),
            resource_type=SlackResourceType.CHANNEL,
            vfs_name=make_id_name(
                ch.get("name", ch.get("id", "unknown")),
                ch["id"],
                path_safe=True,
            ),
            remote_time=str(ch.get("created", 0)),
        )

    @classmethod
    def dm(
        cls,
        dm: dict,
        user_map: dict[str, str],
    ) -> "SlackIndexEntry":
        """Build entry from Slack DM API response.

        Args:
            dm (dict): DM channel object.
            user_map (dict[str, str]): user_id → display name.
        """
        user_id = dm.get("user", "")
        display = user_map.get(user_id, user_id)
        return cls(
            id=dm["id"],
            name=display,
            resource_type=SlackResourceType.DM,
            vfs_name=make_id_name(display, dm["id"], path_safe=True),
            remote_time=str(dm.get("created", 0)),
        )

    @classmethod
    def user(cls, u: dict) -> "SlackIndexEntry":
        """Build entry from Slack user API response."""
        name = u.get("name", u.get("id", "unknown"))
        return cls(
            id=u["id"],
            name=name,
            resource_type=SlackResourceType.USER,
            vfs_name=f"{make_id_name(name, u['id'], path_safe=True)}.json",
        )

    @classmethod
    def history(
        cls,
        channel_id: str,
        date: str,
    ) -> "SlackIndexEntry":
        """Build entry for a date-based history file.

        Example::

            SlackIndexEntry.history("C123", "2025-04-05")
            # vfs_name → "2025-04-05.jsonl"
        """
        return cls(
            id=f"{channel_id}:{date}",
            name=date,
            resource_type=SlackResourceType.HISTORY,
            vfs_name=f"{date}.jsonl",
        )
