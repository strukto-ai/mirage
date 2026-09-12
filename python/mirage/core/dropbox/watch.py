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
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import (continue_folder, list_folder,
                                     list_folder_state)
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.types import (Delta, FileChangeKind, FileEvent, FileMetadata,
                          PathSpec, WalkEntry)
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.constants import DIR_FINGERPRINT
from mirage.watch.delta import ListingDeltaHook, spec_for
from mirage.watch.fingerprint import stat_fingerprint

_NATIVE = 1


class DropboxWalk:
    """One recursive ``list_folder`` feeding the generic listing differ.

    Reads the account directly, never through mirage's caches, as the
    DeltaHook contract requires.

    Fingerprints on ``content_hash``, Dropbox's own content digest, so
    an upload of identical bytes is correctly reported as no change;
    ``rev`` is the fallback, and it moves on any write.

    Dropbox also offers a cursor: the same endpoint returns one, and
    ``list_folder/continue`` replays only what changed since. That is a
    faster pull, not a more correct one, and it cannot replace this
    walk, because the server may invalidate a cursor at any time and
    the only answer to that is a full listing. ``DropboxDeltaHook``
    uses the cursor behind ``pull`` and this walk as its reset path.
    """

    def __init__(self, accessor: DropboxAccessor) -> None:
        """Args:
            accessor (DropboxAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        accessor = self._accessor
        api_root = dropbox_path_of(accessor, root)
        try:
            found = await list_folder(accessor.token_manager,
                                      api_root,
                                      recursive=True)
        except DropboxApiError as exc:
            # list_folder 409s on a missing path and on a file operand;
            # either way there is nothing under this root to report.
            if exc.status == 409:
                return
            raise
        for raw in found:
            framed = _frame(accessor, root, raw)
            if framed is None or raw.get(".tag") == "deleted":
                continue
            yield framed[1]


def _is_reset(exc: DropboxApiError) -> bool:
    return exc.status == 409 and exc.summary.startswith("reset")


def _frame(accessor: DropboxAccessor, root: PathSpec,
           entry: dict[str, Any]) -> tuple[str, WalkEntry] | None:
    """Map one Dropbox listing row onto a watch-root WalkEntry.

    Dropbox paths are case-insensitive: ``path_display`` carries the
    server's casing while ``root_path`` carries the user's, so a
    configured ``/team`` whose displayed path is ``/Team`` matched
    nothing and every event landed outside the watch scope. The
    comparison folds case; the slice keeps the server's casing for
    everything below the root, and is safe because ``path_lower`` is
    ``path_display`` lowercased, same length.
    """
    prefix = mount_prefix_of(root.virtual, root.resource_path)
    display = entry.get("path_display") or entry.get("path_lower")
    if not display:
        return None
    base = accessor.root_path
    folded = base.lower()
    relative = display[len(base):] if base and display.lower().startswith(
        folded) else display
    relative = relative.strip("/")
    if not relative:
        return None
    virtual = (prefix.rstrip("/") + "/" + relative if prefix else "/" +
               relative)
    if entry.get(".tag") == "folder":
        return virtual, WalkEntry(virtual=virtual,
                                  is_dir=True,
                                  fingerprint=None)
    if entry.get(".tag") == "deleted":
        return virtual, WalkEntry(virtual=virtual,
                                  is_dir=False,
                                  fingerprint=None)
    modified = entry.get("server_modified") or entry.get(
        "client_modified") or None
    size = entry.get("size")
    size = size if isinstance(size, int) else None
    version = entry.get("content_hash") or entry.get("rev")
    return virtual, WalkEntry(virtual=virtual,
                              is_dir=False,
                              fingerprint=stat_fingerprint(
                                  version, modified, size),
                              size=size,
                              modified=modified)


def _encode(cursor: str, snapshot: dict[str, str]) -> str:
    return json.dumps({
        "_dbx": _NATIVE,
        "c": cursor,
        "s": snapshot
    },
                      sort_keys=True)


def _decode(
        checkpoint: str | None
) -> tuple[str | None, dict[str, str] | None, bool]:
    """Return (cursor, snapshot, native).

    A listing-era JSON snapshot has no cursor. A native checkpoint
    carries both the server cursor and the last applied snapshot so
    continue rows can be classified as CREATE, UPDATE, or DELETE.
    """
    if checkpoint is None:
        return None, None, False
    data = json.loads(checkpoint)
    if isinstance(data, dict) and data.get("_dbx") == _NATIVE:
        snap = data.get("s")
        cursor = data.get("c")
        if isinstance(snap, dict) and isinstance(cursor, str):
            return cursor, snap, True
    if isinstance(data, dict):
        return None, data, False
    return None, None, False


def _event(root: PathSpec, virtual: str, kind: FileChangeKind,
           entry: WalkEntry | None, observed: datetime) -> FileEvent:
    metadata = None
    if (entry is not None and not entry.is_dir
            and kind is not FileChangeKind.DELETE):
        metadata = FileMetadata(fingerprint=entry.fingerprint,
                                size=entry.size,
                                modified=entry.modified)
    return FileEvent(kind=kind,
                     path=spec_for(root, virtual),
                     timestamp=observed,
                     metadata=metadata)


def _diff_snapshots(
    root: PathSpec,
    previous: dict[str, str],
    current: dict[str, str],
    entries: dict[str, WalkEntry],
    observed: datetime,
) -> list[FileEvent]:
    changes: list[FileEvent] = []
    for virtual in sorted(current.keys() | previous.keys()):
        old = previous.get(virtual)
        new = current.get(virtual)
        if old == new:
            continue
        if old is None and new is not None:
            kind = FileChangeKind.CREATE
        elif new is None:
            kind = FileChangeKind.DELETE
        else:
            kind = FileChangeKind.UPDATE
        changes.append(
            _event(root, virtual, kind, entries.get(virtual), observed))
    return changes


def _drop_prefix(snapshot: dict[str, str], virtual: str) -> None:
    prefix = virtual.rstrip("/") + "/"
    for key in list(snapshot):
        if key == virtual or key.startswith(prefix):
            del snapshot[key]


class DropboxDeltaHook:
    """Native Dropbox cursor pull, with the listing walk as reset.

    ``checkpoint`` is opaque. A native checkpoint stores the server
    cursor plus the last applied snapshot so continue rows classify
    the same way a listing diff would. A listing-era snapshot is
    accepted once, then upgraded. ``path/reset`` falls back to a
    full listing and a new cursor.
    """

    def __init__(self, accessor: DropboxAccessor) -> None:
        """Args:
            accessor (DropboxAccessor): Backend handle.
        """
        self._accessor = accessor
        self._listing = ListingDeltaHook(DropboxWalk(accessor))

    async def _snapshot(
            self, root: PathSpec
    ) -> tuple[dict[str, str], dict[str, WalkEntry], str]:
        accessor = self._accessor
        api_root = dropbox_path_of(accessor, root)
        try:
            found, cursor = await list_folder_state(accessor.token_manager,
                                                    api_root,
                                                    recursive=True)
        except DropboxApiError as exc:
            if exc.status == 409:
                return {}, {}, ""
            raise
        snapshot: dict[str, str] = {}
        entries: dict[str, WalkEntry] = {}
        for raw in found:
            framed = _frame(accessor, root, raw)
            if framed is None or raw.get(".tag") == "deleted":
                continue
            virtual, entry = framed
            entries[virtual] = entry
            snapshot[virtual] = (DIR_FINGERPRINT
                                 if entry.is_dir else entry.fingerprint or "")
        return snapshot, entries, cursor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Pull changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): Native cursor snapshot, a listing
                JSON snapshot, or None for a baseline.
        """
        cursor, previous, native = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        if not native:
            snapshot, entries, cursor = await self._snapshot(root)
            if not cursor:
                return await self._listing.pull(root, checkpoint)
            changes = () if previous is None else tuple(
                _diff_snapshots(root, previous, snapshot, entries, observed))
            return Delta(changes=changes, checkpoint=_encode(cursor, snapshot))
        try:
            found, next_cursor = await continue_folder(
                self._accessor.token_manager, cursor or "")
        except DropboxApiError as exc:
            if _is_reset(exc):
                snapshot, entries, cursor = await self._snapshot(root)
                changes = () if previous is None else tuple(
                    _diff_snapshots(root, previous, snapshot, entries,
                                    observed))
                return Delta(changes=changes,
                             checkpoint=_encode(cursor, snapshot))
            raise
        snapshot = dict(previous or {})
        applied: dict[str, WalkEntry] = {}
        for raw in found:
            framed = _frame(self._accessor, root, raw)
            if framed is None:
                continue
            virtual, entry = framed
            applied[virtual] = entry
            if raw.get(".tag") == "deleted":
                _drop_prefix(snapshot, virtual)
                continue
            snapshot[virtual] = (DIR_FINGERPRINT
                                 if entry.is_dir else entry.fingerprint or "")
        return Delta(changes=tuple(
            _diff_snapshots(root, previous or {}, snapshot, applied,
                            observed)),
                     checkpoint=_encode(next_cursor, snapshot))


def build_delta_hook(accessor: DropboxAccessor) -> DeltaHook:
    """Build the Dropbox delta hook.

    Args:
        accessor (DropboxAccessor): Backend handle.
    """
    return DropboxDeltaHook(accessor)
