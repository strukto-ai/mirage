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

import json
import logging
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import events_now, events_since
from mirage.core.box.constants import (
    EVENT_REPLAY_DAYS,
    EVENT_STREAM,
    PLACE_EVENTS,
    TRASH_EVENTS,
)
from mirage.core.box.resolve import mount_relative_key, root_id
from mirage.events.base import DeltaHook
from mirage.events.delta import events_under
from mirage.events.payload import event_at, field
from mirage.types import Delta, FileChangeKind, FileEvent, JsonValue, PathSpec

logger = logging.getLogger(__name__)


def _ref(item: dict[str, Any]) -> str:
    """The key an item is remembered by: its type and its Box id.

    Files and folders are addressed through separate endpoints, and
    nothing promises their ids never coincide, so the type rides along.

    Args:
        item (dict[str, Any]): A Box file or folder.
    """
    return f"{item.get('type')}:{item['id']}"


def _under(key: str, place: str) -> bool:
    """Whether ``key`` lies strictly below ``place``.

    Args:
        key (str): Path to test.
        place (str): Directory path, spelled the way ``key`` is.
    """
    return key.startswith(place.rstrip("/") + "/")


def _inside(key: str, place: str) -> bool:
    """Whether ``key`` is ``place`` or lies below it.

    Args:
        key (str): Path to test.
        place (str): Directory path, spelled the way ``key`` is.
    """
    return key == place or _under(key, place)


def _rebase(key: str, old: str, new: str) -> str:
    """``key`` moved from under ``old`` to under ``new``, if it was there.

    Args:
        key (str): Path to rewrite.
        old (str): Place a folder left.
        new (str): Place it arrived at.
    """
    return new + key[len(old) :] if _inside(key, old) else key


def _source(value: JsonValue) -> dict[str, Any] | None:
    """The file or folder an event is about, or None.

    User events carry the full item as ``source``, with the
    ``path_collection`` that places it. Web links, users and
    collaborations are not paths on the mount.

    Args:
        value (JsonValue): The event's ``source``.
    """
    if not isinstance(value, dict) or value.get("type") not in (
        "file",
        "folder",
    ):
        return None
    if not value.get("id"):
        return None
    return value


def _created(event: dict[str, Any]) -> datetime | None:
    """When an event happened, or None when it carries no readable stamp.

    Args:
        event (dict[str, Any]): One ``/events`` entry.
    """
    value = event.get("created_at")
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value)
    except ValueError:
        logger.debug(
            "box event %s: unreadable created_at %r",
            event.get("event_id"),
            value,
        )
        return None
    if stamp.tzinfo is None:
        return stamp.replace(tzinfo=timezone.utc)
    return stamp


def _ordered(events: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each event once, in the order it happened.

    Box may send an event more than once or out of order: a repeat
    carries the same ``event_id``, and ``created_at`` gives the order. A
    tie keeps the order Box sent, and an event with no stamp stays behind
    the one before it.

    Args:
        events (Sequence[dict[str, Any]]): Events as ``events_since``
            read them.
    """
    seen: set[str] = set()
    stamped: list[tuple[datetime, dict[str, Any]]] = []
    stamp = datetime.min.replace(tzinfo=timezone.utc)
    for event in events:
        event_id = event.get("event_id")
        if event_id:
            if event_id in seen:
                continue
            seen.add(event_id)
        stamp = _created(event) or stamp
        stamped.append((stamp, event))
    stamped.sort(key=lambda pair: pair[0])
    return [event for _, event in stamped]


class BoxDeltaHook:
    """What changed on a Box mount since the last stream position, for
    the consumer to call when Box pings.

    Box's push (``realtime_server``'s long poll answering
    ``new_change``) carries no change, so each ping is answered by one
    read of the user event stream from the stored position, each event
    mapped as ``BoxEventHook`` maps it, with the places it remembers
    kept in the checkpoint. A baseline takes the stream's present
    position and lists nothing.

    Box never refuses an old ``stream_position``: user events are kept
    for two weeks to two months, and a stale position replays whatever
    is left, so a checkpoint older than ``EVENT_REPLAY_DAYS`` answers
    UNKNOWN on the event root and starts again at the present. Box may
    also send an event twice or out of order, so each pull maps its
    events once each, in ``created_at`` order.
    """

    def __init__(self, accessor: BoxAccessor) -> None:
        """Args:
        accessor (BoxAccessor): Backend handle.
        """
        self._accessor = accessor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root.
            checkpoint (str | None): The previous pull's state, or None
                for a baseline.
        """
        tm = self._accessor.token_manager
        state = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        if state is None:
            position = await events_now(tm, EVENT_STREAM)
            return Delta((), _encode(position, observed, {}))
        position, read, paths = state
        if observed - read > timedelta(days=EVENT_REPLAY_DAYS):
            fresh = await events_now(tm, EVENT_STREAM)
            lost = FileEvent(
                kind=FileChangeKind.UNKNOWN, path=root, timestamp=observed
            )
            return Delta((lost,), _encode(fresh, observed, {}))
        found, position = await events_since(tm, position, EVENT_STREAM)
        mapper = BoxEventHook(self._accessor, paths)
        events: list[FileEvent] = []
        for event in _ordered(found):
            events.extend(
                await mapper.to_events(
                    root, str(event.get("event_type") or ""), event
                )
            )
        return Delta(
            tuple(events_under(root, events)),
            _encode(position, observed, mapper.paths),
        )


def _encode(position: str, read: datetime, paths: dict[str, str]) -> str:
    return json.dumps(
        {
            "box": {
                "position": position,
                "read": read.isoformat(),
                "paths": paths,
            }
        },
        sort_keys=True,
    )


def _decode(
    checkpoint: str | None,
) -> tuple[str, datetime, dict[str, str]] | None:
    """The stream position, when it was read and the remembered places a
    checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    state = json.loads(checkpoint).get("box") or {}
    paths = state.get("paths") or {}
    return (
        str(state.get("position") or "now"),
        datetime.fromisoformat(str(state.get("read"))),
        {str(k): str(v) for k, v in paths.items()},
    )


class BoxEventHook:
    """Map one Box user event onto mount paths.

    The consumer owns the long poll: ``realtime_server`` gives the URL,
    a ``new_change`` answer means read ``events_since`` from the last
    position, and each event read goes through ``to_events`` with its
    ``event_type``. Nothing here runs a loop.

    An event names the item's new place only, and a trashed item's place
    is the Trash, so the hook remembers where each item it has mapped
    was, and moves or forgets a folder's contents along with it. An item
    it has never seen gets the honest answer instead: a move or rename
    of one is UNKNOWN on the directory it landed in, and a trash of one
    maps to nothing and rides the index TTL, as Slack's unmapped deletes
    do.

    A folder stands for everything below it, which Box sends no events
    for, so a place a folder leaves or lands on is UNKNOWN, which takes
    the whole subtree whatever the index holds; only a folder created empty
    (``ITEM_CREATE``) is a CREATE. The mount root has no path of its
    own, so its trash or restore is UNKNOWN on the whole mount.

    Upload of a new version and of a new file are the same
    ``ITEM_UPLOAD``, so the split between CREATE and UPDATE is also
    whether the item was seen before.
    """

    def __init__(
        self, accessor: BoxAccessor, paths: dict[str, str] | None = None
    ) -> None:
        """Args:
        accessor (BoxAccessor): Backend handle, read for its root
            folder.
        paths (dict[str, str] | None): Where each item mapped before
            was, by ref, as ``paths`` handed it out.
        """
        self._accessor = accessor
        self._paths: dict[str, str] = dict(paths or {})

    @property
    def paths(self) -> dict[str, str]:
        """Where each item the hook has mapped is, by ref."""
        return dict(self._paths)

    def _leave(
        self, root: PathSpec, ref: str, old: str | None, is_dir: bool
    ) -> Sequence[FileEvent]:
        """Forget an item that left the mount, and report where it was.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            ref (str): The item's ref.
            old (str | None): Where the hook last saw it, if anywhere.
            is_dir (bool): Whether the item is a folder.
        """
        if old is None:
            return ()
        if is_dir:
            self._paths = {
                r: path
                for r, path in self._paths.items()
                if not _inside(path, old)
            }
            return (event_at(root, old, FileChangeKind.UNKNOWN),)
        self._paths.pop(ref, None)
        return (event_at(root, old, FileChangeKind.DELETE),)

    def _move(
        self, root: PathSpec, ref: str, old: str, new: str, is_dir: bool
    ) -> Sequence[FileEvent]:
        """Follow an item that moved within the mount.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            ref (str): The item's ref.
            old (str): Where the hook last saw it.
            new (str): Where the event puts it.
            is_dir (bool): Whether the item is a folder.
        """
        if is_dir:
            self._paths = {
                r: _rebase(path, old, new) for r, path in self._paths.items()
            }
            return (
                event_at(root, old, FileChangeKind.UNKNOWN),
                event_at(root, new, FileChangeKind.UNKNOWN),
            )
        self._paths[ref] = new
        return (event_at(root, new, FileChangeKind.MOVE, previous=old),)

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one Box event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The event's ``event_type``.
            payload (JsonValue): The event object from ``/events``.
        """
        source = _source(field(payload, "source"))
        if source is None:
            return ()
        is_dir = source.get("type") == "folder"
        mount_root = root_id(self._accessor)
        if is_dir and str(source["id"]) == mount_root:
            if (
                event_type in TRASH_EVENTS
                or event_type == "ITEM_UNDELETE_VIA_TRASH"
            ):
                return (event_at(root, "", FileChangeKind.UNKNOWN),)
            return ()
        ref = _ref(source)
        old = self._paths.get(ref)
        if event_type in TRASH_EVENTS:
            return self._leave(root, ref, old, is_dir)
        if event_type not in PLACE_EVENTS:
            return ()
        relative = mount_relative_key(source, mount_root)
        if relative is None:
            return self._leave(root, ref, old, is_dir)
        if old is not None and old != relative:
            return self._move(root, ref, old, relative, is_dir)
        self._paths[ref] = relative
        if old is None and event_type in ("ITEM_MOVE", "ITEM_RENAME"):
            parent = relative.rsplit("/", 1)[0] if "/" in relative else ""
            return (event_at(root, parent, FileChangeKind.UNKNOWN),)
        if is_dir:
            kind = (
                FileChangeKind.CREATE
                if event_type == "ITEM_CREATE"
                else FileChangeKind.UNKNOWN
            )
        elif old is not None or event_type == "ITEM_MAKE_CURRENT_VERSION":
            kind = FileChangeKind.UPDATE
        else:
            kind = FileChangeKind.CREATE
        return (event_at(root, relative, kind),)


def build_delta_hook(accessor: BoxAccessor) -> DeltaHook:
    """Build the Box delta hook.

    Args:
        accessor (BoxAccessor): Backend handle.
    """
    return BoxDeltaHook(accessor)
