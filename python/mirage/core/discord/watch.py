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

from collections.abc import Sequence
from typing import Any

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.channels import TEXT_CHANNEL_TYPES
from mirage.core.discord.client import discord_get
from mirage.core.discord.constants import (
    CHANNEL_EVENTS,
    CHAT_FILE,
    FILES_DIR,
    GUILD_EVENTS,
    MEMBER_EVENTS,
    MESSAGE_EVENTS,
    REACTION_EVENTS,
    THREAD_TYPES,
)
from mirage.core.discord.entry import (
    channel_dirname,
    guild_dirname,
    snowflake_to_date,
)
from mirage.core.discord.files import file_blob_name, is_listed
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.watch.events import event_at, field, text_field


def _day_of(message_id: str) -> str | None:
    """The UTC day a message id was minted on, or None.

    Args:
        message_id (str): A Discord snowflake.
    """
    if not message_id.isdigit():
        return None
    return snowflake_to_date(message_id)


class DiscordEventHook:
    """Map one Discord gateway dispatch onto mount paths.

    The consumer holds the gateway connection, and passes each
    dispatch's ``t`` with its ``d``. Nothing here runs a loop.

    A message is a row of ``chat.jsonl`` in the day its id was minted
    on, in UTC as ``readdir`` buckets it, so an edit, a delete or a
    reaction refreshes the day the message was posted, never today.
    Every directory carries a name, and a dispatch names a guild and a
    channel by id only, so each id is resolved once through
    ``/guilds/<id>`` or ``/channels/<id>`` and remembered; a channel or
    guild dispatch forgets what it renamed.

    A thread is not listed, and its messages are in no day file. What
    changes is the thread's starter message in its parent channel,
    which carries the thread's counts and has the thread's id, so a
    message in a thread refreshes the parent's day of the thread id.

    A new message's attachments are created at the names ``readdir``
    gives them. An edit or a delete does not say which attachments went
    with it, so that day's ``files`` directory is UNKNOWN. A channel,
    member or guild dispatch changes a listing's names, so it is UNKNOWN
    on the listing: ``channels``, ``members``, or the whole mount for a
    guild, which also fires for every guild when the gateway reconnects
    and so re-inventories what the gap missed. A direct message belongs
    to no guild and maps to nothing.
    """

    def __init__(self, accessor: DiscordAccessor) -> None:
        """Args:
        accessor (DiscordAccessor): Backend handle, read for its
            config and used to resolve guild and channel ids.
        """
        self._accessor = accessor
        self._guilds: dict[str, str] = {}
        self._channels: dict[str, dict[str, Any]] = {}

    async def _get(self, endpoint: str) -> dict[str, Any]:
        """One object from the API.

        Args:
            endpoint (str): The path under the API root.
        """
        data = await discord_get(
            self._accessor.config, endpoint, session=self._accessor.pool
        )
        return data if isinstance(data, dict) else {}

    async def _guild_dir(self, guild_id: str) -> str:
        """The directory a guild id maps to, memoized.

        Args:
            guild_id (str): A guild snowflake.
        """
        cached = self._guilds.get(guild_id)
        if cached is None:
            guild = await self._get(f"/guilds/{guild_id}")
            guild.setdefault("id", guild_id)
            cached = guild_dirname(guild)
            self._guilds[guild_id] = cached
        return cached

    async def _channel(self, channel_id: str) -> dict[str, Any]:
        """The channel object an id names, memoized.

        Args:
            channel_id (str): A channel snowflake.
        """
        cached = self._channels.get(channel_id)
        if cached is None:
            cached = await self._get(f"/channels/{channel_id}")
            cached.setdefault("id", channel_id)
            self._channels[channel_id] = cached
        return cached

    async def _day_dir(
        self, channel_id: str | None, message_id: str | None
    ) -> tuple[str, bool] | None:
        """The day directory whose ``chat.jsonl`` holds a message's row,
        and whether the message is in a thread, or None when no listed
        channel holds it.

        Args:
            channel_id (str | None): The dispatch's ``channel_id``.
            message_id (str | None): The message's id.
        """
        if channel_id is None or message_id is None:
            return None
        channel = await self._channel(channel_id)
        thread = channel.get("type") in THREAD_TYPES
        if thread:
            parent_id = channel.get("parent_id")
            if not isinstance(parent_id, str):
                return None
            message_id = channel_id
            channel = await self._channel(parent_id)
        guild_id = channel.get("guild_id")
        if channel.get("type") not in TEXT_CHANNEL_TYPES or not isinstance(
            guild_id, str
        ):
            return None
        day = _day_of(message_id)
        if day is None:
            return None
        guild = await self._guild_dir(guild_id)
        return f"{guild}/channels/{channel_dirname(channel)}/{day}", thread

    async def _messages(
        self,
        root: PathSpec,
        event_type: str,
        payload: JsonValue,
        message_ids: Sequence[str],
    ) -> Sequence[FileEvent]:
        """The day files a run of messages in one channel touched.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The dispatch's ``t``.
            payload (JsonValue): The dispatch's ``d``.
            message_ids (Sequence[str]): The messages it names.
        """
        changes: dict[str, FileChangeKind] = {}
        for message_id in message_ids:
            place = await self._day_dir(
                text_field(payload, "channel_id"), message_id
            )
            if place is None:
                continue
            day_dir, thread = place
            changes[f"{day_dir}/{CHAT_FILE}"] = FileChangeKind.UPDATE
            if thread or event_type in REACTION_EVENTS:
                continue
            if event_type != "MESSAGE_CREATE":
                changes[f"{day_dir}/{FILES_DIR}"] = FileChangeKind.UNKNOWN
                continue
            attachments = field(payload, "attachments")
            for att in attachments if isinstance(attachments, list) else ():
                if isinstance(att, dict) and is_listed(att):
                    name = file_blob_name(att)
                    changes[f"{day_dir}/{FILES_DIR}/{name}"] = (
                        FileChangeKind.CREATE
                    )
        return tuple(
            event_at(root, path, kind) for path, kind in changes.items()
        )

    async def _listing(
        self, root: PathSpec, payload: JsonValue, name: str
    ) -> Sequence[FileEvent]:
        """UNKNOWN on one of a guild's listings.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            payload (JsonValue): The dispatch's ``d``, naming the guild.
            name (str): ``channels`` or ``members``.
        """
        guild_id = text_field(payload, "guild_id")
        if guild_id is None:
            return ()
        guild = await self._guild_dir(guild_id)
        return (event_at(root, f"{guild}/{name}", FileChangeKind.UNKNOWN),)

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one gateway dispatch to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The dispatch's ``t``.
            payload (JsonValue): The dispatch's ``d``.
        """
        if event_type in MESSAGE_EVENTS or event_type in REACTION_EVENTS:
            key = "id" if event_type in MESSAGE_EVENTS else "message_id"
            own = text_field(payload, key)
            ids = [own] if own is not None else []
            return await self._messages(root, event_type, payload, ids)
        if event_type == "MESSAGE_DELETE_BULK":
            listed = field(payload, "ids")
            ids = [
                i
                for i in (listed if isinstance(listed, list) else ())
                if isinstance(i, str)
            ]
            return await self._messages(root, event_type, payload, ids)
        own = text_field(payload, "id")
        if event_type in CHANNEL_EVENTS:
            if own is not None and isinstance(payload, dict):
                self._channels.pop(own, None)
                if event_type != "CHANNEL_DELETE":
                    self._channels[own] = dict(payload)
            return await self._listing(root, payload, "channels")
        if event_type in MEMBER_EVENTS:
            return await self._listing(root, payload, "members")
        if event_type in GUILD_EVENTS:
            if own is not None and isinstance(payload, dict):
                self._guilds.pop(own, None)
                if text_field(payload, "name") is not None:
                    self._guilds[own] = guild_dirname(dict(payload))
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        return ()
