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

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import slack_get
from mirage.core.slack.formatters import channel_dirname, dm_dirname
from mirage.core.slack.watch.constants import (CHANNEL_LIST_EVENTS, CHAT_FILE,
                                               DM_LIST_EVENTS, FILES_DIR,
                                               ITEM_EVENTS, USER_LIST_EVENTS)
from mirage.core.slack.watch.payload import (affected_ts, channel_id_of,
                                             day_of, item_channel)
from mirage.core.slack.watch.types import ConversationDir
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.watch.events import event_at, text_field


class SlackEventHook:
    """Map one Slack Events API delivery onto mount paths.

    The consumer runs the transport (an HTTP endpoint for the Events
    API or a Socket Mode websocket), unwraps the ``event_callback``
    envelope and passes the inner event's ``type`` with its body.

    Every path this returns is rebuilt with the same functions
    ``readdir`` names directories with, which is the reason this lives
    beside the backend rather than in the consumer: a channel is
    ``<name>__<C-id>`` through ``make_id_name``, a DM is the *user's*
    name through ``dm_dirname``, and the day is bucketed in UTC. Slack
    shows local time, so a consumer reimplementing the last rule would
    name tomorrow's directory for a fifth of the day and never see an
    error, because a notify on a path the mount does not serve evicts
    nothing.

    Resolution is the reason this holds state. An event names a channel
    by id only, and the directory carries the name, so the id has to be
    resolved through ``conversations.info`` (plus ``users.info`` for a
    DM, whose directory is named after the other person). That is one
    or two API calls the first time a conversation is seen and none
    after, against a Slack tier that allows roughly 50 a minute; a
    stateless mapper would spend a call per message. A rename drops the
    entry rather than patching it, since the whole subtree moved and
    the answer is a re-inventory anyway.

    Three kinds of event map to something coarser than a file, and
    honestly so. A listing change (a channel created, renamed or
    archived; a user's profile edited) is UNKNOWN on the container
    directory, because the entry names themselves changed. A shared
    file is UNKNOWN on that day's ``files`` directory, because the
    rendered filename comes from ``file_blob_name`` over metadata the
    notification does not carry, and the accompanying ``message`` event
    already refreshes ``chat.jsonl``.

    Two file events are unmapped, and neither is unmappable. A file
    blob is addressed by the day it was *shared*, and neither event
    carries a conversation or that day: ``file_change`` sends only
    ``file_id``, ``file_deleted`` sends ``file_id`` and the deletion's
    own ``event_ts``. Asking Slack does not recover it either, since
    ``files.info`` on a deleted file answers with the ``file_deleted``
    error. What does recover it is this mount's own index, which stores
    each blob's Slack id as ``IndexEntry.id``, so a reverse lookup
    names the exact path; and a file the index has never seen is one
    nothing has cached, so there is nothing to invalidate. The hook
    simply is not handed the index today. Until it is, both ride the
    index TTL, which bounds the staleness rather than removing it.

    ``channel_shared`` / ``channel_unshared`` are a third that looks
    like a gap and is not: they change only the Slack Connect flags on
    the channel object, never its ``name`` or ``id``, which are the two
    things the directory is spelled from.
    """

    def __init__(self, accessor: SlackAccessor) -> None:
        """Args:
            accessor (SlackAccessor): Backend handle, read for its
                config and used to resolve conversation ids.
        """
        self._accessor = accessor
        self._dirs: dict[str, ConversationDir] = {}
        self._users: dict[str, str] = {}

    async def _user_name(self, user_id: str) -> str:
        """Display name for a user id, memoized.

        Args:
            user_id (str): A Slack user id.
        """
        cached = self._users.get(user_id)
        if cached is not None:
            return cached
        data = await slack_get(self._accessor.config,
                               "users.info", {"user": user_id},
                               session=self._accessor.pool)
        user = data.get("user") or {}
        name = str(user.get("name") or user_id)
        self._users[user_id] = name
        return name

    async def _resolve(self, channel_id: str) -> ConversationDir:
        """Directory a conversation id maps to, memoized.

        Args:
            channel_id (str): A Slack conversation id.
        """
        cached = self._dirs.get(channel_id)
        if cached is not None:
            return cached
        data = await slack_get(self._accessor.config,
                               "conversations.info", {"channel": channel_id},
                               session=self._accessor.pool)
        channel = data.get("channel") or {}
        channel.setdefault("id", channel_id)
        if channel.get("is_im") or channel.get("is_mpim"):
            user_id = str(channel.get("user") or "")
            user_map = ({
                user_id: await self._user_name(user_id)
            } if user_id else {})
            resolved = ConversationDir("dms", dm_dirname(channel, user_map))
        else:
            resolved = ConversationDir("channels", channel_dirname(channel))
        self._dirs[channel_id] = resolved
        return resolved

    async def _day_dir(self, channel_id: str, ts: str) -> str | None:
        """Mount-relative day directory for a conversation and ts.

        Args:
            channel_id (str): A Slack conversation id.
            ts (str): The Slack timestamp to bucket.
        """
        day = day_of(ts)
        if day is None:
            return None
        where = await self._resolve(channel_id)
        return f"{where.container}/{where.dirname}/{day}"

    async def _transcripts(self, root: PathSpec, channel_id: str | None,
                           stamps: Sequence[str]) -> Sequence[FileEvent]:
        """One UPDATE per day directory the stamps land in.

        Args:
            root (PathSpec): Any path on the target mount.
            channel_id (str | None): The conversation, if the event named one.
            stamps (Sequence[str]): Timestamps whose days went stale.
        """
        out: list[FileEvent] = []
        for ts in stamps:
            out.extend(await self._transcript(root, channel_id, ts))
        return tuple(out)

    async def _transcript(self, root: PathSpec, channel_id: str | None,
                          ts: str | None) -> Sequence[FileEvent]:
        """One UPDATE on the transcript a conversation and ts name.

        Args:
            root (PathSpec): Any path on the target mount.
            channel_id (str | None): The conversation, if the event named one.
            ts (str | None): The timestamp, if the event named one.
        """
        if channel_id is None or ts is None:
            return ()
        day_dir = await self._day_dir(channel_id, ts)
        if day_dir is None:
            return ()
        return (event_at(root, f"{day_dir}/{CHAT_FILE}",
                         FileChangeKind.UPDATE), )

    async def _file_shared(self, root: PathSpec,
                           payload: JsonValue) -> Sequence[FileEvent]:
        """Map a shared file onto that day's attachment directory.

        Args:
            root (PathSpec): Any path on the target mount.
            payload (JsonValue): The ``file_shared`` event body.
        """
        channel_id = text_field(payload, "channel_id")
        ts = text_field(payload, "event_ts")
        if channel_id is None or ts is None:
            return ()
        day_dir = await self._day_dir(channel_id, ts)
        if day_dir is None:
            return ()
        return (event_at(root, f"{day_dir}/{FILES_DIR}",
                         FileChangeKind.UNKNOWN), )

    def _forget(self, payload: JsonValue) -> None:
        """Drop a memoized directory name the event just invalidated.

        Args:
            payload (JsonValue): A channel listing event body.
        """
        channel_id = channel_id_of(payload)
        if channel_id is not None:
            self._dirs.pop(channel_id, None)

    async def to_events(self, root: PathSpec, event_type: str,
                        payload: JsonValue) -> Sequence[FileEvent]:
        """Map one Slack event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The inner event's ``type``.
            payload (JsonValue): The inner event body.
        """
        if event_type == "message":
            return await self._transcripts(root,
                                           text_field(payload, "channel"),
                                           affected_ts(payload))
        if event_type in ITEM_EVENTS:
            channel_id, ts = item_channel(payload)
            return await self._transcript(root, channel_id, ts)
        if event_type == "file_shared":
            return await self._file_shared(root, payload)
        if event_type in CHANNEL_LIST_EVENTS:
            self._forget(payload)
            return (event_at(root, "channels", FileChangeKind.UNKNOWN), )
        if event_type in DM_LIST_EVENTS:
            return (event_at(root, "dms", FileChangeKind.UNKNOWN), )
        if event_type in USER_LIST_EVENTS:
            return (event_at(root, "users", FileChangeKind.UNKNOWN), )
        return ()
