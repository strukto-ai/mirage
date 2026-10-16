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

import logging
from collections.abc import Sequence
from typing import Any

import aiohttp

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
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec

logger = logging.getLogger(__name__)


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
    and so re-inventories what the gap missed; it also forgets the
    guild's channels, since one renamed during the gap kept its old
    name here. A direct message belongs to no guild and maps to nothing.
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

    async def _guild_dir(self, guild_id: str) -> str | None:
        """The directory a guild id maps to, memoized, or None when the
        guild is gone.

        Args:
            guild_id (str): A guild snowflake.
        """
        cached = self._guilds.get(guild_id)
        if cached is None:
            try:
                guild = await self._get(f"/guilds/{guild_id}")
            except aiohttp.ClientResponseError as exc:
                if exc.status != 404:
                    raise
                logger.debug("discord guild %s is gone: %s", guild_id, exc)
                return None
            guild.setdefault("id", guild_id)
            cached = guild_dirname(guild)
            self._guilds[guild_id] = cached
        return cached

    async def _channel(self, channel_id: str) -> dict[str, Any] | None:
        """The channel object an id names, memoized, or None when the
        channel is gone.

        Args:
            channel_id (str): A channel snowflake.
        """
        cached = self._channels.get(channel_id)
        if cached is None:
            try:
                cached = await self._get(f"/channels/{channel_id}")
            except aiohttp.ClientResponseError as exc:
                if exc.status != 404:
                    raise
                logger.debug("discord channel %s is gone: %s", channel_id, exc)
                return None
            cached.setdefault("id", channel_id)
            self._channels[channel_id] = cached
        return cached

    async def _messages(
        self,
        root: PathSpec,
        event_type: str,
        payload: JsonValue,
        message_ids: Sequence[str],
    ) -> Sequence[FileEvent]:
        """The day files a run of messages in one channel touched.

        A dispatch handled after its channel or guild was deleted cannot
        name the channel, so it is UNKNOWN on the guild's ``channels``,
        or on the mount when the guild is gone too.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The dispatch's ``t``.
            payload (JsonValue): The dispatch's ``d``.
            message_ids (Sequence[str]): The messages it names.
        """
        channel_id = text_field(payload, "channel_id")
        if channel_id is None:
            return ()
        channel = await self._channel(channel_id)
        thread = False
        if channel is not None and channel.get("type") in THREAD_TYPES:
            parent_id = channel.get("parent_id")
            if not isinstance(parent_id, str):
                return ()
            thread = True
            message_ids = [channel_id]
            channel = await self._channel(parent_id)
        if channel is None:
            return await self._listing(root, payload, "channels")
        guild_id = channel.get("guild_id")
        if channel.get("type") not in TEXT_CHANNEL_TYPES or not isinstance(
            guild_id, str
        ):
            return ()
        guild = await self._guild_dir(guild_id)
        if guild is None:
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        channel_dir = f"{guild}/channels/{channel_dirname(channel)}"
        changes: dict[str, FileChangeKind] = {}
        for message_id in message_ids:
            day = _day_of(message_id)
            if day is None:
                continue
            day_dir = f"{channel_dir}/{day}"
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
        """UNKNOWN on one of a guild's listings, or on the mount when the
        guild is gone.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            payload (JsonValue): The dispatch's ``d``, naming the guild.
            name (str): ``channels`` or ``members``.
        """
        guild_id = text_field(payload, "guild_id")
        if guild_id is None:
            return ()
        guild = await self._guild_dir(guild_id)
        if guild is None:
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
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
                for channel_id, channel in list(self._channels.items()):
                    if channel.get("guild_id") == own:
                        del self._channels[channel_id]
                if text_field(payload, "name") is not None:
                    self._guilds[own] = guild_dirname(dict(payload))
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        return ()
