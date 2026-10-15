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
from collections.abc import Iterable
from datetime import datetime, timezone

from mirage.runtime.python.host.host_io import with_host_io
from mirage.types import (
    Delta,
    FileChangeKind,
    FileEvent,
    FileMetadata,
    PathSpec,
    WalkEntry,
    WalkFn,
)
from mirage.watch.constants import DIR_FINGERPRINT


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
    """The changes a watch on ``root`` reports: each at or below it as
    itself, and each at a directory above it as the root's own, since
    that directory removed removes the root, and any other change to it
    may have moved the root (UNKNOWN).

    Args:
        root (PathSpec): Watch root.
        changes (Iterable[tuple[FileChangeKind, str]]): Each change and
            the virtual path it is at.
        observed (datetime): Timestamp every event carries.
    """
    top = root.virtual.rstrip("/")
    events: list[FileEvent] = []
    for kind, virtual in changes:
        if virtual == top or virtual.startswith(top + "/"):
            events.append(
                FileEvent(
                    kind=kind, path=spec_for(root, virtual), timestamp=observed
                )
            )
        elif top.startswith(virtual.rstrip("/") + "/"):
            gone = kind is FileChangeKind.DELETE
            events.append(
                FileEvent(
                    kind=kind if gone else FileChangeKind.UNKNOWN,
                    path=root,
                    timestamp=observed,
                )
            )
    return events


def diff_snapshots(
    root: PathSpec,
    previous: dict[str, str],
    current: dict[str, str],
    entries: dict[str, WalkEntry],
    observed: datetime,
) -> tuple[FileEvent, ...]:
    """Classify two ``{virtual: fingerprint}`` snapshots as changes.

    A key only in ``current`` is a CREATE, one only in ``previous`` a
    DELETE, and a changed fingerprint an UPDATE. A file change that is
    not a DELETE carries the metadata of its row in ``entries``, when
    there is one.

    Args:
        root (PathSpec): Watch root carrying the mount prefix.
        previous (dict[str, str]): Snapshot the last pull handed out.
        current (dict[str, str]): Snapshot as of this pull.
        entries (dict[str, WalkEntry]): Rows read this pull, by path.
        observed (datetime): Timestamp every change carries.
    """
    changes: list[FileEvent] = []
    for virtual in sorted(current.keys() | previous.keys()):
        old = previous.get(virtual)
        new = current.get(virtual)
        if old == new:
            continue
        if old is None:
            kind = FileChangeKind.CREATE
        elif new is None:
            kind = FileChangeKind.DELETE
        else:
            kind = FileChangeKind.UPDATE
        entry = entries.get(virtual)
        metadata = None
        if (
            entry is not None
            and not entry.is_dir
            and kind is not FileChangeKind.DELETE
        ):
            metadata = FileMetadata(
                fingerprint=entry.fingerprint,
                size=entry.size,
                modified=entry.modified,
            )
        changes.append(
            FileEvent(
                kind=kind,
                path=spec_for(root, virtual),
                timestamp=observed,
                metadata=metadata,
            )
        )
    return tuple(changes)


class ListingDeltaHook:
    """Generic checkpointed delta over a full backend walk.

    Snapshots the tree under the watch root as ``{virtual: fingerprint}``
    and diffs consecutive snapshots: new keys are CREATE, missing keys
    are DELETE, changed fingerprints are UPDATE. A baseline pull
    (``checkpoint=None``) establishes the snapshot and emits nothing.
    The walk callable reads the backend directly and must not go
    through mirage's caches.
    """

    def __init__(self, walk: WalkFn) -> None:
        """Args:
        walk (WalkFn): Async generator over all entries under a
            root, reading the backend directly.
        """
        self._walk = walk

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Walk ``root`` and diff against ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): JSON snapshot from the previous
                pull, or None for a baseline.
        """
        snapshot: dict[str, str] = {}
        entries: dict[str, WalkEntry] = {}
        # The walk reads the backend, so its own paths are host paths:
        # a disk mount rooted at its own prefix spells them like virtual
        # ones, and the process patch must not answer them (host_io).
        async for entry in with_host_io(self._walk(root)):
            entries[entry.virtual] = entry
            if entry.is_dir:
                snapshot[entry.virtual] = DIR_FINGERPRINT
            else:
                snapshot[entry.virtual] = entry.fingerprint or ""
        serialized = json.dumps(snapshot, sort_keys=True)
        if checkpoint is None:
            return Delta(changes=(), checkpoint=serialized)
        previous: dict[str, str] = json.loads(checkpoint)
        return Delta(
            changes=diff_snapshots(
                root, previous, snapshot, entries, datetime.now(timezone.utc)
            ),
            checkpoint=serialized,
        )
