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
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Any

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.api import DriveApi
from mirage.core.gdrive.readdir import unique_shared_drive_name
from mirage.core.gdrive.resolve import root_context
from mirage.core.google.client import GoogleApiError
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT
from mirage.core.google.events import feed_checkpoint, feed_state
from mirage.events.base import DeltaHook
from mirage.events.delta import (
    changes_under,
    folder_path,
    just_made,
    lost_at,
    moved_below,
    settle,
)
from mirage.events.payload import text_field, virtual_of
from mirage.types import Delta, FileChangeKind, PathSpec

logger = logging.getLogger(__name__)


def _is_folder(item: dict[str, Any]) -> bool:
    """Whether a changed item is a folder the hook places by name; a
    shared drive's root is named by the root listing instead.

    Args:
        item (dict[str, Any]): A Drive file or folder.
    """
    if item.get("mimeType") != FOLDER_MIME:
        return False
    return not (item.get("driveId") and not item.get("parents"))


def _filename_of(item: dict[str, Any]) -> str:
    """The name the listing gives ``item``.

    Args:
        item (dict[str, Any]): A Drive file or folder.
    """
    return str(item["name"]) + MIME_TO_EXT.get(item.get("mimeType", ""), "")


class _Places:
    """Where items sit on a Drive mount, found by their parents up to the
    mount root, for one read.

    Each folder looked up is kept (name and parent, by id) in
    ``folders``, which the checkpoint carries to the next read.
    """

    def __init__(
        self,
        drive: DriveApi,
        top: str,
        scoped: bool,
        folders: dict[str, list[str]],
    ) -> None:
        """Args:
        drive (DriveApi): The account's Drive client.
        top (str): The mount root's folder id.
        scoped (bool): Whether the mount is scoped to a folder.
        folders (dict[str, list[str]]): Each known folder's name and
            parent, by id; "" for a parent outside the mount.
        """
        self.folders = folders
        self._drive = drive
        self._top = top
        self._scoped = scoped
        self._drives: dict[str, str] | None = None
        self._drive_roots: set[str] = set()

    def kept(self) -> dict[str, list[str]]:
        """The folders the checkpoint carries: every one looked up but a
        shared drive's root, whose name the root listing assigns afresh
        whenever My Drive's own top entries change."""
        return {
            k: v for k, v in self.folders.items() if k not in self._drive_roots
        }

    async def under(self, parents: list[str]) -> str | None:
        """The mount path of the folder an item sits in, "" for the root,
        None when it is outside the mount.

        Args:
            parents (list[str]): The item's parents.
        """
        if not parents:
            return None
        if parents[0] == self._top:
            return ""
        return await self.folder(parents[0])

    async def folder(self, folder_id: str) -> str | None:
        """The mount path of a folder, None when it is outside the mount.

        Args:
            folder_id (str): The folder's id.
        """
        return await folder_path(
            folder_id, self._top, self.folders, self._look_up
        )

    async def _look_up(self, folder_id: str) -> list[str] | None:
        """A folder's name and parent, None when it is gone; a shared drive's
        root sits under an unscoped mount's root by the name its listing
        gives it, and nowhere on a scoped one.

        Args:
            folder_id (str): The folder's id.
        """
        try:
            item = await self._drive.get_file(folder_id)
        except GoogleApiError as exc:
            if exc.status != HTTPStatus.NOT_FOUND:
                raise
            logger.debug("drive folder %s is gone: %s", folder_id, exc)
            return None
        parents = item.get("parents") or []
        if item.get("driveId") and not parents:
            self._drive_roots.add(folder_id)
            name = "" if self._scoped else await self._drive_name(folder_id)
            return [name, self._top if name else ""]
        return [item["name"], parents[0] if parents else ""]

    async def _drive_name(self, drive_id: str) -> str:
        """The name the root listing gives a shared drive, "" when the
        account no longer lists it.

        Args:
            drive_id (str): The shared drive's id.
        """
        if self._drives is None:
            taken = {
                _filename_of(f) for f in await self._drive.list_files("root")
            }
            self._drives = {}
            for shared in await self._drive.list_shared_drives():
                name = unique_shared_drive_name(shared["name"], taken)
                taken.add(name)
                self._drives[shared["id"]] = name
        return self._drives.get(drive_id, "")


class GDriveDeltaHook:
    """Checkpointed delta over Drive's change feed.

    Drive pings a channel with no body, so a ping reads ``changes.list``
    from the page token the last read handed out. A change names an item
    by id, with its name and parents, so the hook places it by its
    parents up to the mount root, keeping each folder it has looked up
    (name and parent, by id) in the checkpoint, where the folders' own
    changes keep them current. An item whose parents never reach the
    root is outside the mount. The checkpoint also keeps the path of each
    item a read placed: one that moves leaves that path, with everything
    below a folder, and one deleted, trashed or no longer shared leaves
    it. An item seen for the first time is created when it is as Drive
    made it (its created and modified times agree) and updated
    otherwise; one removed before any
    read placed it names nothing, and is left to the index's expiry. On
    an unscoped mount, whose root lists the shared drives, a shared drive
    made, renamed or left reports the root as unknown. Each read first
    applies the feed's folder renames and moves, so an item listed before
    its folder is still placed where the folder is now, and a shared
    drive is named afresh each read, as the root listing may rename it.
    An item the feed lists more than once is taken at its last change.
    """

    def __init__(self, accessor: GDriveAccessor) -> None:
        """Args:
        accessor (GDriveAccessor): Backend handle.
        """
        self._accessor = accessor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root.
            checkpoint (str | None): The previous read's state, or None
                for a baseline.
        """
        drive = self._accessor.drive
        observed = datetime.now(timezone.utc)
        folder_id, _ = await root_context(self._accessor)
        scoped = folder_id != "root"
        state = feed_state(checkpoint)
        if state is None:
            token = await drive.start_page_token()
            top = folder_id if scoped else (await drive.get_file("root"))["id"]
            return Delta(
                (),
                _encode(token, top, {}, {}),
            )
        found, token = await drive.list_changes(state["token"])
        top = str(state["root"])
        places = _Places(
            drive,
            top,
            scoped,
            {k: list(v) for k, v in (state.get("folders") or {}).items()},
        )
        seen: dict[str, str] = dict(state.get("seen") or {})
        changes: list[tuple[FileChangeKind, str]] = []
        unknown = False
        latest: dict[str, tuple[str, dict[str, Any] | None, bool]] = {}
        for change in found:
            if change.get("changeType") == "drive":
                unknown = unknown or not scoped
                continue
            item_id = text_field(change, "fileId")
            if item_id is None:
                continue
            item = change.get("file")
            if not isinstance(item, dict):
                item = None
            gone = bool(
                change.get("removed") or item is None or item.get("trashed")
            )
            if item_id == top:
                if gone:
                    changes.append(
                        (FileChangeKind.DELETE, virtual_of(root, ""))
                    )
                continue
            latest.pop(item_id, None)
            latest[item_id] = (item_id, item, gone)
        entries = list(latest.values())
        for item_id, _, _ in entries:
            if item_id not in seen and item_id in places.folders:
                placed = await places.folder(item_id)
                if placed is not None:
                    seen[item_id] = virtual_of(root, placed)
        for item_id, item, gone in entries:
            if item is not None and _is_folder(item):
                parents = item.get("parents") or [""]
                places.folders[item_id] = [item["name"], parents[0]]
            elif gone:
                places.folders.pop(item_id, None)
        moves: dict[str, str | None] = {}
        for item_id, item, gone in entries:
            where = None
            if item is not None:
                base = await places.under(item.get("parents") or [])
                if base is not None:
                    where = virtual_of(root, f"{base}/{_filename_of(item)}")
            if gone and where is not None:
                seen.setdefault(item_id, where)
            now = None if gone else where
            made = item is not None and just_made(
                item.get("createdTime"), item.get("modifiedTime")
            )
            was = settle(changes, seen, item_id, now, made)
            if was is not None and was != now:
                moves[was] = now
        moved_below(seen, moves, {item_id for item_id, _, _ in entries})
        events = changes_under(root, changes, observed)
        if unknown:
            events.append(lost_at(root, observed))
        return Delta(
            tuple(events),
            _encode(token, top, places.kept(), seen),
        )


def _encode(
    token: str,
    top: str,
    folders: dict[str, list[str]],
    seen: dict[str, str],
) -> str:
    """Encode the state the next read starts from.

    Args:
        token (str): The page token the next read starts at.
        top (str): The mount root's folder id.
        folders (dict[str, list[str]]): Each known folder's name and
            parent, by id.
        seen (dict[str, str]): Each placed item's path, by id.
    """
    return feed_checkpoint(
        {
            "token": token,
            "root": top,
            "folders": folders,
            "seen": seen,
        }
    )


def build_delta_hook(accessor: GDriveAccessor) -> DeltaHook:
    """Build the Google Drive delta hook (``GDriveDeltaHook``).

    Args:
        accessor (GDriveAccessor): Backend handle.
    """
    return GDriveDeltaHook(accessor)
