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

from collections.abc import Awaitable, Callable, Iterable
from datetime import datetime

from mirage.types import FileChangeKind, FileEvent, PathSpec


def spec_for(root: PathSpec, virtual: str) -> PathSpec:
    """Build a PathSpec for ``virtual`` using ``root``'s mount framing.

    The mount prefix length is recovered from the (virtual,
    vfs_path) pair of the root, the same arithmetic as
    ``PathSpec.dir``.

    Args:
        root (PathSpec): Watch root carrying the mount prefix.
        virtual (str): Workspace-virtual path under the same mount.
    """
    cut = len(root.virtual.rstrip("/")) - len(root.vfs_path)
    return PathSpec.from_str_path(virtual, vfs_path=virtual[cut:].strip("/"))


def changes_under(
    root: PathSpec,
    changes: Iterable[tuple[FileChangeKind, str]],
    observed: datetime,
) -> list[FileEvent]:
    """The changes a watch on ``root`` reports (``events_under``), from
    each change and the virtual path it is at.

    Args:
        root (PathSpec): Watch root.
        changes (Iterable[tuple[FileChangeKind, str]]): Each change and
            the virtual path it is at.
        observed (datetime): Timestamp every event carries.
    """
    return events_under(
        root,
        (
            FileEvent(
                kind=kind, path=spec_for(root, virtual), timestamp=observed
            )
            for kind, virtual in changes
        ),
    )


def events_under(
    root: PathSpec, events: Iterable[FileEvent]
) -> list[FileEvent]:
    """The events a watch on ``root`` reports: each at or below it as
    itself, and each at a directory above it as the root's own, since
    that directory removed removes the root, and any other change to it
    may have moved the root (UNKNOWN). A move out of the root is a
    delete where it was.

    Args:
        root (PathSpec): Watch root.
        events (Iterable[FileEvent]): Events framed on the root's mount.
    """
    top = root.virtual.rstrip("/")

    def inside(virtual: str) -> bool:
        return virtual == top or virtual.startswith(top + "/")

    kept: list[FileEvent] = []
    for event in events:
        virtual = event.path.virtual
        previous = event.previous_path
        if inside(virtual):
            kept.append(event)
        elif previous is not None and inside(previous.virtual):
            kept.append(
                FileEvent(
                    kind=FileChangeKind.DELETE,
                    path=previous,
                    timestamp=event.timestamp,
                )
            )
        elif top.startswith(virtual.rstrip("/") + "/"):
            gone = event.kind is FileChangeKind.DELETE
            kept.append(
                FileEvent(
                    kind=event.kind if gone else FileChangeKind.UNKNOWN,
                    path=root,
                    timestamp=event.timestamp,
                )
            )
    return kept


def settle(
    changes: list[tuple[FileChangeKind, str]],
    seen: dict[str, str],
    item_id: str,
    now: str | None,
    made: bool,
) -> str | None:
    """Record how one item of a feed that names items by id moved from
    where the last read placed it to ``now``, and return where it was.

    An item seen before leaves its old path when it moved and is updated
    in place otherwise; one not seen before is created when it is as the
    service made it and updated otherwise, since where it was is not
    known.

    Args:
        changes (list[tuple[FileChangeKind, str]]): The changes so far.
        seen (dict[str, str]): Each placed item's virtual path, by id.
        item_id (str): The item's id.
        now (str | None): Its virtual path now, None when it left.
        made (bool): Whether it is as the service made it.
    """
    was = seen.pop(item_id, None)
    if now is None:
        if was is not None:
            changes.append((FileChangeKind.DELETE, was))
        return was
    seen[item_id] = now
    if was is None:
        kind = FileChangeKind.CREATE if made else FileChangeKind.UPDATE
        changes.append((kind, now))
    elif was != now:
        changes.append((FileChangeKind.DELETE, was))
        changes.append((FileChangeKind.CREATE, now))
    else:
        changes.append((FileChangeKind.UPDATE, now))
    return was


def moved_below(
    seen: dict[str, str], moves: dict[str, str | None], placed: set[str]
) -> None:
    """Carry each kept path below a folder that moved to the folder's new
    path, or forget it when the folder left.

    The moves of one read apply at once, each path by the deepest folder
    it was below, so a folder that takes another's old name does not
    pull in what the other held. Paths the read placed itself are where
    their items are now and stay as they are.

    Args:
        seen (dict[str, str]): Each placed item's virtual path, by id.
        moves (dict[str, str | None]): Each moved folder's old path and
            its new one, None when it left.
        placed (set[str]): The ids the read placed.
    """
    for item_id, path in list(seen.items()):
        if item_id in placed:
            continue
        was = max(
            (old for old in moves if path.startswith(old + "/")),
            key=len,
            default=None,
        )
        if was is None:
            continue
        now = moves[was]
        if now is None:
            del seen[item_id]
        else:
            seen[item_id] = now + path[len(was) :]


def just_made(created: str | None, modified: str | None) -> bool:
    """Whether an item is as it was made: its creation and last
    modification times, both the service's own clock, agree.

    Args:
        created (str | None): The item's creation time, ISO 8601.
        modified (str | None): Its last modification time, ISO 8601.
    """
    if not created or not modified:
        return False
    return datetime.fromisoformat(created) == datetime.fromisoformat(modified)


async def folder_path(
    folder_id: str,
    top: str,
    folders: dict[str, list[str]],
    look_up: Callable[[str], Awaitable[list[str] | None]],
) -> str | None:
    """The path of a folder below the folder ``top`` by each folder's
    name and parent, "" for ``top`` itself, None when its parents never
    reach ``top``.

    Args:
        folder_id (str): The folder's id.
        top (str): The id of the folder paths start at.
        folders (dict[str, list[str]]): Each known folder's name and
            parent id, by id; a parent of "" is outside. Each folder
            looked up is added.
        look_up (Callable[[str], Awaitable[list[str] | None]]): Fetch a
            folder's name and parent id, None when it is gone.
    """
    names: list[str] = []
    visited: set[str] = set()
    current = folder_id
    while current != top:
        if current in visited:
            return None
        visited.add(current)
        entry = folders.get(current)
        if entry is None:
            entry = await look_up(current)
            if entry is None:
                return None
            folders[current] = entry
        if not entry[1]:
            return None
        names.append(entry[0])
        current = entry[1]
    return "/".join(reversed(names))
