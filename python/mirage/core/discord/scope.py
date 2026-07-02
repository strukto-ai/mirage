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

import re
from dataclasses import dataclass

from mirage.cache.index import IndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class DiscordScope:
    """Resolved scope for a discord path.

    Attributes:
        level (str): one of ``root``, ``guild``, ``channel``, ``date``,
            ``messages``, ``files``, ``file_blob``, ``member``.
        guild_id (str | None): guild snowflake.
        channel_id (str | None): channel snowflake.
        date_str (str | None): ``YYYY-MM-DD`` for date-level and below.
        resource_path (str): resource-relative key (prefix stripped).
    """

    level: str
    guild_id: str | None = None
    channel_id: str | None = None
    date_str: str | None = None
    resource_path: str = "/"


def _strip_prefix(raw: str, prefix: str) -> str:
    stripped = raw.strip("/")
    if not prefix:
        return stripped
    pfx = prefix.strip("/")
    if stripped == pfx:
        return ""
    if stripped.startswith(pfx + "/"):
        return stripped[len(pfx) + 1:]
    return stripped


async def detect_scope(
    path: PathSpec,
    index: IndexCacheStore = None,
) -> DiscordScope:
    """Determine scope from a path.

    Examples::

        /                                              → root
        /<guild>                                       → guild
        /<guild>/channels                              → guild
        /<guild>/members                               → guild
        /<guild>/channels/<ch>                         → channel
        /<guild>/members/<user>.json                   → member
        /<guild>/channels/<ch>/<date>                  → date
        /<guild>/channels/<ch>/<date>/chat.jsonl       → messages
        /<guild>/channels/<ch>/<date>/files            → files
        /<guild>/channels/<ch>/<date>/files/<blob>     → file_blob
    """
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))

    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""

    if path.pattern and path.pattern.endswith(".jsonl"):
        dir_key = _strip_prefix(path.directory, prefix)
        parts = dir_key.split("/") if dir_key else []
        if len(parts) >= 3 and parts[1] == "channels":
            guild_id, channel_id = await _resolve_ids(parts[0],
                                                      "/".join(parts[:3]),
                                                      index, prefix)
            date_str = (parts[3] if len(parts) == 4
                        and _DATE_RE.match(parts[3]) else None)
            return DiscordScope(
                level="messages" if date_str else "channel",
                guild_id=guild_id,
                channel_id=channel_id,
                date_str=date_str,
                resource_path=dir_key,
            )

    key = _strip_prefix(path.virtual, prefix)

    if not key:
        return DiscordScope(level="root", resource_path="/")

    parts = key.split("/")

    # /<guild>/channels/<ch>/<date>/files/<blob>
    if (len(parts) == 6 and parts[1] == "channels" and _DATE_RE.match(parts[3])
            and parts[4] == "files"):
        guild_id, channel_id = await _resolve_ids(parts[0],
                                                  "/".join(parts[:3]), index,
                                                  prefix)
        return DiscordScope(
            level="file_blob",
            guild_id=guild_id,
            channel_id=channel_id,
            date_str=parts[3],
            resource_path=key,
        )

    # /<guild>/channels/<ch>/<date>/chat.jsonl or .../files
    if (len(parts) == 5 and parts[1] == "channels"
            and _DATE_RE.match(parts[3])):
        guild_id, channel_id = await _resolve_ids(parts[0],
                                                  "/".join(parts[:3]), index,
                                                  prefix)
        if parts[4] == "chat.jsonl":
            return DiscordScope(
                level="messages",
                guild_id=guild_id,
                channel_id=channel_id,
                date_str=parts[3],
                resource_path=key,
            )
        if parts[4] == "files":
            return DiscordScope(
                level="files",
                guild_id=guild_id,
                channel_id=channel_id,
                date_str=parts[3],
                resource_path=key,
            )

    # /<guild>/channels/<ch>/<date>
    if (len(parts) == 4 and parts[1] == "channels"
            and _DATE_RE.match(parts[3])):
        guild_id, channel_id = await _resolve_ids(parts[0],
                                                  "/".join(parts[:3]), index,
                                                  prefix)
        return DiscordScope(
            level="date",
            guild_id=guild_id,
            channel_id=channel_id,
            date_str=parts[3],
            resource_path=key,
        )

    # /<guild>/channels/<ch>
    if len(parts) == 3 and parts[1] == "channels":
        guild_id, channel_id = await _resolve_ids(parts[0], key, index, prefix)
        return DiscordScope(
            level="channel",
            guild_id=guild_id,
            channel_id=channel_id,
            resource_path=key,
        )

    # /<guild>/members/<user>.json
    if len(parts) == 3 and parts[1] == "members":
        guild_id = await _resolve_guild_id(parts[0], index, prefix)
        return DiscordScope(
            level="member",
            guild_id=guild_id,
            resource_path=key,
        )

    # /<guild>, /<guild>/channels, /<guild>/members
    if len(parts) <= 2:
        guild_id = await _resolve_guild_id(parts[0], index, prefix)
        return DiscordScope(
            level="guild",
            guild_id=guild_id,
            resource_path=key,
        )

    return DiscordScope(level="file_blob", resource_path=key)


async def coalesce_scopes(
    paths: list[PathSpec],
    index: IndexCacheStore = None,
) -> DiscordScope | None:
    if not paths:
        return None
    scopes = [await detect_scope(p, index) for p in paths]
    first = scopes[0]
    if first.guild_id is None or first.channel_id is None:
        return None
    for s in scopes[1:]:
        if (s.guild_id != first.guild_id or s.channel_id != first.channel_id):
            return None
    return DiscordScope(
        level="channel",
        guild_id=first.guild_id,
        channel_id=first.channel_id,
        resource_path=first.resource_path.rsplit("/", 1)[0]
        if first.level == "messages" else first.resource_path,
    )


async def _resolve_guild_id(
    guild_name: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> str | None:
    if index is None:
        return None
    virtual_key = prefix + "/" + guild_name if prefix else "/" + guild_name
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        return lookup.entry.id
    return None


async def _resolve_ids(
    guild_name: str,
    channel_path: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> tuple[str | None, str | None]:
    guild_id = await _resolve_guild_id(guild_name, index, prefix)
    channel_id = None
    if index is not None:
        virtual_key = (prefix + "/" + channel_path if prefix else "/" +
                       channel_path)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            channel_id = lookup.entry.id
    return guild_id, channel_id
