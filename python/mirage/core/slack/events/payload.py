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

from datetime import datetime, timezone

from mirage.events.payload import field, text_field
from mirage.types import JsonValue


def day_of(ts: str) -> str | None:
    """UTC day directory for a Slack timestamp.

    Bucketing is UTC because ``_date_range`` in ``readdir`` is, so a
    6pm PDT message belongs to the *next* day's directory. Reading the
    consumer's local clock here would name a directory the mount does
    not serve, and a notify on a path that does not exist is silent.

    Args:
        ts (str): A Slack ts (``"1755290000.001"``) or event_ts.
    """
    try:
        seconds = float(ts)
    except ValueError:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).date().isoformat()


def item_channel(payload: JsonValue) -> tuple[str | None, str | None]:
    """Channel and ts a reaction or pin event points at.

    Both wrap the thing they happened to in an ``item`` rather than
    naming it at the top level, and both spell the id ``channel``
    inside it where ``file_shared`` spells it ``channel_id`` outside.

    Args:
        payload (JsonValue): The event body.
    """
    item = field(payload, "item")
    return text_field(item, "channel"), text_field(item, "ts")


def subject(payload: JsonValue) -> JsonValue:
    """The message object an event is about.

    An edit and a deletion both describe another message rather than
    themselves, and nest it under a different key.

    Args:
        payload (JsonValue): The message event body.
    """
    kind = text_field(payload, "subtype")
    if kind == "message_deleted":
        return field(payload, "previous_message") or payload
    if kind == "message_changed":
        return field(payload, "message") or payload
    return payload


def message_ts(payload: JsonValue) -> str | None:
    """The ts of the message an event is about.

    Not always the event's own ``ts``: an edit and a deletion both
    arrive stamped now while naming a message from any earlier day, so
    taking the top-level ts would refresh today's directory and leave
    the day that actually changed stale.

    Args:
        payload (JsonValue): The message event body.
    """
    if text_field(payload, "subtype") == "message_deleted":
        deleted = text_field(payload, "deleted_ts")
        if deleted is not None:
            return deleted
    return text_field(subject(payload), "ts")


def is_broadcast(payload: JsonValue) -> bool:
    """Whether a thread reply was also sent to the channel.

    Args:
        payload (JsonValue): The message event body.
    """
    body = subject(payload)
    if text_field(body, "subtype") == "thread_broadcast":
        return True
    return field(body, "reply_broadcast") is True


def affected_ts(payload: JsonValue) -> tuple[str, ...]:
    """Timestamps whose day directories a message event makes stale.

    Usually just the message's own, but a thread reply is the case that
    breaks that: ``chat.jsonl`` renders ``conversations.history``, which
    returns parents only, so a reply is in no day file at all. What
    changed is the *parent's* row, whose ``reply_count`` and
    ``latest_reply`` the same listing carries, in the parent's day. A
    reply to a week-old thread therefore refreshes a week-old
    directory and leaves today's alone.

    A broadcast reply is the exception to the exception: Slack puts it
    in the channel history too, so both days change.

    Args:
        payload (JsonValue): The message event body.
    """
    own = message_ts(payload)
    if own is None:
        return ()
    thread = text_field(subject(payload), "thread_ts")
    if thread is None or thread == own:
        return (own,)
    return (thread, own) if is_broadcast(payload) else (thread,)


def channel_id_of(payload: JsonValue) -> str | None:
    """The conversation id a listing event names.

    Slack spells it two ways for the same family: ``channel_deleted``
    sends the bare id, ``channel_rename`` sends the whole channel
    object.

    Args:
        payload (JsonValue): A channel listing event body.
    """
    direct = text_field(payload, "channel")
    if direct is not None:
        return direct
    return text_field(field(payload, "channel"), "id")
