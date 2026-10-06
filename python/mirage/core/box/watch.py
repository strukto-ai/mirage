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
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import (
    absent_on_404,
    events_now,
    events_since,
    list_folder_items,
)
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.constants import (
    EVENT_REPLAY_DAYS,
    EVENT_STREAM,
    PLACE_EVENTS,
    TRASH_EVENTS,
)
from mirage.core.box.resolve import (
    mount_relative_key,
    path_parts,
    resolve_chain,
    root_id,
)
from mirage.types import (
    Delta,
    FileChangeKind,
    FileEvent,
    JsonValue,
    PathSpec,
    WalkEntry,
)
from mirage.watch.base import DeltaHook
from mirage.watch.constants import DIR_FINGERPRINT
from mirage.watch.delta import diff_snapshots
from mirage.watch.events import event_at, field, virtual_of
from mirage.watch.fingerprint import stat_fingerprint

logger = logging.getLogger(__name__)

_NATIVE = 1


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


def _entry(virtual: str, item: dict[str, Any]) -> WalkEntry:
    """One walk row for a Box item, fingerprinted the way stat does.

    The fingerprint matches what ``ReaddirWalk`` built from Box stat, so a
    listing-era checkpoint upgrades without reporting every file.

    Args:
        virtual (str): Virtual path the item sits at.
        item (dict[str, Any]): A folder listing row or an event source.
    """
    if item.get("type") == "folder":
        return WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
    modified = item.get("modified_at") or None
    size = item.get("size")
    size = size if isinstance(size, int) else None
    return WalkEntry(
        virtual=virtual,
        is_dir=False,
        fingerprint=stat_fingerprint(
            item.get("sha1") or modified, modified, size
        ),
        size=size,
        modified=modified,
    )


async def _walk(
    tm: BoxTokenManager, folder_id: str, virtual: str
) -> AsyncIterator[tuple[str, WalkEntry]]:
    """Yield (ref, entry) for everything under one folder.

    Web links are skipped, as readdir hides them. A folder removed
    mid-walk is skipped; the next pull settles it.

    Args:
        tm (BoxTokenManager): token manager.
        folder_id (str): Box id of the folder to walk.
        virtual (str): Virtual path the folder sits at.
    """
    try:
        items = await absent_on_404(
            virtual, lambda: list_folder_items(tm, folder_id)
        )
    except FileNotFoundError:
        return
    for item in items:
        if item.get("type") not in ("file", "folder"):
            continue
        child = f"{virtual.rstrip('/')}/{item['name']}"
        yield _ref(item), _entry(child, item)
        if item.get("type") == "folder":
            async for row in _walk(tm, str(item["id"]), child):
                yield row


class _Tree:
    """The last applied snapshot, plus the item behind each path.

    Events name items by id, and neither a move nor a trash says where
    the item was, so the ref map is what finds the old path. A file is
    one key; a folder is its whole subtree, which Box sends no events for.
    """

    def __init__(self, snapshot: dict[str, str], refs: dict[str, str]) -> None:
        """Args:
        snapshot (dict[str, str]): ``{virtual: fingerprint}``.
        refs (dict[str, str]): ``{ref: virtual}`` for the same
            entries.
        """
        self.snapshot = dict(snapshot)
        self.refs = dict(refs)
        self.entries: dict[str, WalkEntry] = {}

    def put(self, ref: str, entry: WalkEntry) -> None:
        """Record an item at its path.

        Args:
            ref (str): The item's ref.
            entry (WalkEntry): Its row.
        """
        self.snapshot[entry.virtual] = (
            DIR_FINGERPRINT if entry.is_dir else entry.fingerprint or ""
        )
        self.refs[ref] = entry.virtual
        self.entries[entry.virtual] = entry

    def drop(self, ref: str, virtual: str) -> None:
        """Forget an item, and a folder's subtree with it.

        Args:
            ref (str): The item's ref.
            virtual (str): Path it was at.
        """
        if self.snapshot.get(virtual) != DIR_FINGERPRINT:
            self.snapshot.pop(virtual, None)
            self.refs.pop(ref, None)
            return
        self.snapshot = {
            key: value
            for key, value in self.snapshot.items()
            if not _inside(key, virtual)
        }
        self.refs = {
            r: key for r, key in self.refs.items() if not _inside(key, virtual)
        }

    def move(self, old: str, new: str) -> None:
        """Carry a folder and its subtree from ``old`` to ``new``.

        Args:
            old (str): Path the folder was at.
            new (str): Path it is at now.
        """
        self.snapshot = {
            _rebase(key, old, new): value
            for key, value in self.snapshot.items()
        }
        self.refs = {r: _rebase(key, old, new) for r, key in self.refs.items()}


@dataclass(frozen=True, slots=True)
class _Native:
    """What a native checkpoint carries next to its snapshot.

    Args:
        position (str): Stream position the next read starts from.
        walked (datetime): When the snapshot was last walked.
        refs (dict[str, str]): ``{ref: virtual}`` for the snapshot.
        chain (list[str]): Folder ids from the mount root down to the
            watch root, as far as the last walk resolved it.
    """

    position: str
    walked: datetime
    refs: dict[str, str]
    chain: list[str]


def _encode(
    position: str, walked: datetime, tree: _Tree, chain: Sequence[str]
) -> str:
    return json.dumps(
        {
            "_box": _NATIVE,
            "p": position,
            "w": walked.isoformat(),
            "s": tree.snapshot,
            "i": tree.refs,
            "r": list(chain),
        },
        sort_keys=True,
    )


def _decode(
    checkpoint: str | None,
) -> tuple[dict[str, str] | None, _Native | None]:
    """Return (last snapshot, native state).

    A listing-era checkpoint is a bare ``{virtual: fingerprint}`` map
    with no stream position; it is diffed against a fresh walk once and
    upgraded.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None, None
    data = json.loads(checkpoint)
    if not isinstance(data, dict):
        return None, None
    if data.get("_box") != _NATIVE:
        return data, None
    return data["s"], _Native(
        position=data["p"],
        walked=datetime.fromisoformat(data["w"]),
        refs=data["i"],
        chain=data["r"],
    )


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
    """Box ``/events`` pull, with the per-folder walk as reset.

    The user event stream is account-wide, so every event is placed
    through its ``path_collection`` and dropped unless it lands under
    the watch root. A move arrives as one ``ITEM_MOVE`` (or
    ``ITEM_RENAME``) naming only the new location, and a trashed item's
    place is the Trash, which is why the checkpoint keeps the item behind
    each path next to the snapshot: its ref finds the old path, and a
    moved folder carries its subtree with it. A folder that shows up
    already populated (a copy, a restore, a move in from outside the
    root) is walked, since Box sends one event for the folder and none
    for what is inside.

    The snapshot is keyed by path from the watch root down, so an event
    that moves, trashes or restores the watch root or a folder above it,
    or lands a folder on the watch root's path, changes where every entry
    is. The checkpoint keeps the ids of that chain of folders, and such
    an event walks again instead of being applied.

    Box never refuses an old ``stream_position``: user events are kept
    for two weeks to two months, and a stale position replays whatever
    is left. It may also send an event twice or out of order; a pull
    applies its events once each in ``created_at`` order, but one that
    arrives a pull late can still leave a path wrong. So the walk also
    runs once the snapshot was walked more than ``EVENT_REPLAY_DAYS``
    ago, which bounds both. It reads the stream head before it lists, so
    a write that lands mid-walk is replayed by the next pull rather than
    lost; the fingerprint diff discards the repeat.

    Only placements and trashes are applied, so a folder shared into or
    out of the account through a collaboration surfaces at the next walk.
    """

    def __init__(self, accessor: BoxAccessor) -> None:
        """Args:
        accessor (BoxAccessor): Backend handle.
        """
        self._accessor = accessor

    def _place(self, root: PathSpec, item: dict[str, Any]) -> str | None:
        """Virtual path an event puts ``item`` at, or None off the mount.

        Args:
            root (PathSpec): Watch root, read for its mount prefix.
            item (dict[str, Any]): The event's source.
        """
        relative = mount_relative_key(item, root_id(self._accessor))
        return None if relative is None else virtual_of(root, relative)

    async def _chain(self, root: PathSpec) -> list[str]:
        """Folder ids from the mount root down to the watch root.

        A component that is missing, or not a folder, ends the chain, so
        it reaches the watch root only when there is a folder to walk.

        Args:
            root (PathSpec): Watch root.
        """
        parts = path_parts(root)
        try:
            found = await absent_on_404(
                root.virtual, lambda: resolve_chain(self._accessor, parts)
            )
        except FileNotFoundError:
            found = []
        chain = [root_id(self._accessor)]
        for item in found:
            if item.get("type") != "folder":
                break
            chain.append(str(item["id"]))
        return chain

    def _moves_root(
        self, root: PathSpec, chain: Sequence[str], event: dict[str, Any]
    ) -> bool:
        """Whether ``event`` moves, removes or replaces the watch root.

        A folder of the chain that is trashed, or placed anywhere but its
        own spot above the root, moves every path in the snapshot. Any
        other folder landing on the root's path, or on a folder above it,
        may put a tree where the snapshot has none.

        Args:
            root (PathSpec): Watch root.
            chain (Sequence[str]): Folder ids from the last walk.
            event (dict[str, Any]): One ``/events`` entry.
        """
        source = _source(event.get("source"))
        kind = event.get("event_type")
        if (
            source is None
            or source.get("type") != "folder"
            or (kind not in PLACE_EVENTS and kind not in TRASH_EVENTS)
        ):
            return False
        place = self._place(root, source)
        folder_id = str(source["id"])
        if folder_id in chain:
            if kind in TRASH_EVENTS:
                return True
            above = path_parts(root)[: chain.index(folder_id)]
            return place != virtual_of(root, "/".join(above))
        if kind in TRASH_EVENTS or place is None:
            return False
        return _inside(virtual_of(root, root.vfs_path), place)

    async def _relist(
        self,
        root: PathSpec,
        previous: dict[str, str] | None,
        observed: datetime,
    ) -> Delta:
        """Walk ``root`` afresh, from the current stream head.

        Args:
            root (PathSpec): Watch root.
            previous (dict[str, str] | None): Last applied snapshot, or
                None for a baseline.
            observed (datetime): Timestamp carried by every event.
        """
        tm = self._accessor.token_manager
        position = await events_now(tm, EVENT_STREAM)
        chain = await self._chain(root)
        tree = _Tree({}, {})
        if len(chain) > len(path_parts(root)):
            async for ref, entry in _walk(
                tm, chain[-1], virtual_of(root, root.vfs_path)
            ):
                tree.put(ref, entry)
        changes = (
            ()
            if previous is None
            else diff_snapshots(
                root, previous, tree.snapshot, tree.entries, observed
            )
        )
        return Delta(
            changes=changes,
            checkpoint=_encode(position, observed, tree, chain),
        )

    async def _apply(
        self, root: PathSpec, here: str, tree: _Tree, event: dict[str, Any]
    ) -> None:
        """Bring the tree up to date with one event.

        Args:
            root (PathSpec): Watch root, read for its mount prefix.
            here (str): The watch root's virtual path.
            tree (_Tree): Snapshot being brought up to date.
            event (dict[str, Any]): One ``/events`` entry.
        """
        source = _source(event.get("source"))
        if source is None:
            return
        ref = _ref(source)
        kind = event.get("event_type")
        old = tree.refs.get(ref)
        if kind in TRASH_EVENTS:
            if old is not None:
                tree.drop(ref, old)
            return
        if kind not in PLACE_EVENTS:
            return
        place = self._place(root, source)
        if place is not None and not _under(place, here):
            place = None
        is_dir = source.get("type") == "folder"
        if old is not None and old != place:
            if place is not None and is_dir:
                tree.move(old, place)
                return
            tree.drop(ref, old)
        if place is None:
            return
        tree.put(ref, _entry(place, source))
        if is_dir and old is None:
            async for row in _walk(
                self._accessor.token_manager, str(source["id"]), place
            ):
                tree.put(*row)

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Pull changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): Native event-stream checkpoint, a
                listing JSON snapshot, or None for a baseline.
        """
        previous, native = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        if native is None or observed - native.walked > timedelta(
            days=EVENT_REPLAY_DAYS
        ):
            return await self._relist(root, previous, observed)
        found, position = await events_since(
            self._accessor.token_manager, native.position, EVENT_STREAM
        )
        events = _ordered(found)
        if any(self._moves_root(root, native.chain, e) for e in events):
            return await self._relist(root, previous, observed)
        here = virtual_of(root, root.vfs_path)
        tree = _Tree(previous or {}, native.refs)
        for event in events:
            await self._apply(root, here, tree, event)
        return Delta(
            changes=diff_snapshots(
                root, previous or {}, tree.snapshot, tree.entries, observed
            ),
            checkpoint=_encode(position, native.walked, tree, native.chain),
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
    do. The pull (``BoxDeltaHook``) is the truth path for both.

    A folder stands for everything below it, which Box sends no events
    for, so a place a folder leaves or lands on is UNKNOWN, which takes
    the whole subtree whatever the index holds; only a folder created empty
    (``ITEM_CREATE``) is a CREATE. The mount root has no path of its
    own, so its trash or restore is UNKNOWN on the whole mount.

    Upload of a new version and of a new file are the same
    ``ITEM_UPLOAD``, so the split between CREATE and UPDATE is also
    whether the item was seen before.
    """

    def __init__(self, accessor: BoxAccessor) -> None:
        """Args:
        accessor (BoxAccessor): Backend handle, read for its root
            folder.
        """
        self._accessor = accessor
        self._paths: dict[str, str] = {}

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
