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
from datetime import datetime, timezone
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import continue_folder, latest_cursor
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.events.base import DeltaHook
from mirage.events.delta import changes_under
from mirage.events.payload import virtual_of
from mirage.types import Delta, FileChangeKind, PathSpec

logger = logging.getLogger(__name__)


def _is_reset(exc: DropboxApiError) -> bool:
    return exc.status == 409 and exc.summary.startswith("reset")


def _relative_of(
    accessor: DropboxAccessor, entry: dict[str, Any]
) -> str | None:
    """A listing row's mount-relative path, or None for the mount root.

    Dropbox paths are case-insensitive: ``path_display`` carries the
    server's casing while ``root_path`` carries the user's, so the root
    is stripped case-folded and the rest keeps the server's casing,
    which is safe because ``path_lower`` is ``path_display`` lowercased,
    same length.

    Args:
        accessor (DropboxAccessor): Backend handle, read for its root.
        entry (dict[str, Any]): One ``list_folder/continue`` row.
    """
    display = entry.get("path_display") or entry.get("path_lower")
    if not display:
        return None
    base = accessor.root_path
    relative = (
        display[len(base) :]
        if base and display.lower().startswith(base.lower())
        else display
    )
    return relative.strip("/") or None


def _encode(cursor: str, seen: dict[str, str]) -> str:
    return json.dumps(
        {"dropbox": {"cursor": cursor, "seen": seen}}, sort_keys=True
    )


def _decode(checkpoint: str | None) -> tuple[str, dict[str, str]] | None:
    """The cursor and seen paths a checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    state = json.loads(checkpoint).get("dropbox") or {}
    seen = state.get("seen") or {}
    return str(state.get("cursor") or ""), {
        str(k): str(v) for k, v in seen.items()
    }


def _drop_below(seen: dict[str, str], relative: str) -> None:
    for key in [
        k for k in seen if k == relative or k.startswith(relative + "/")
    ]:
        del seen[key]


class DropboxDeltaHook:
    """What changed under a Dropbox event root since the last cursor, for
    the consumer to call when Dropbox pings.

    Dropbox's push (a webhook, or ``list_folder/longpoll`` answering
    ``changes``) names only the account, so each ping is answered by one
    ``list_folder/continue`` from the stored cursor. A baseline takes a
    cursor at the present with ``get_latest_cursor`` and lists nothing.

    A row names its path, so a delete is a DELETE where it was, and a
    move is its old path deleted and its new rows. A row does not say
    whether a file was made or replaced, so the checkpoint keeps each
    path a pull has reported with its ``content_hash``: a path seen
    before is an UPDATE, or nothing when its content did not change, and
    any other is a CREATE. A cursor Dropbox resets answers UNKNOWN on
    the event root and a fresh cursor; a root Dropbox cannot find has no
    cursor, and the pull that finds it again reports the root UNKNOWN.
    """

    def __init__(self, accessor: DropboxAccessor) -> None:
        """Args:
        accessor (DropboxAccessor): Backend handle.
        """
        self._accessor = accessor

    async def _latest(self, root: PathSpec) -> str:
        """A cursor at the root's present, "" when Dropbox cannot find it.

        Args:
            root (PathSpec): Event root.
        """
        accessor = self._accessor
        try:
            return await latest_cursor(
                accessor.token_manager,
                dropbox_path_of(accessor, root),
                recursive=True,
            )
        except DropboxApiError as exc:
            if exc.status != 409:
                raise
            logger.debug("dropbox event root has no cursor: %s", exc)
            return ""

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root.
            checkpoint (str | None): The previous pull's state, or None
                for a baseline.
        """
        state = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        lost = [(FileChangeKind.UNKNOWN, root.virtual)]
        if state is None:
            return Delta((), _encode(await self._latest(root), {}))
        cursor, seen = state
        if not cursor:
            cursor = await self._latest(root)
            changes = changes_under(root, lost, observed) if cursor else []
            return Delta(tuple(changes), _encode(cursor, {}))
        try:
            rows, cursor = await continue_folder(
                self._accessor.token_manager, cursor
            )
        except DropboxApiError as exc:
            if not _is_reset(exc):
                raise
            logger.debug("dropbox cursor reset: %s", exc)
            fresh = await self._latest(root)
            return Delta(
                tuple(changes_under(root, lost, observed)), _encode(fresh, {})
            )
        found: list[tuple[FileChangeKind, str]] = []
        for row in rows:
            relative = _relative_of(self._accessor, row)
            if relative is None:
                continue
            virtual = virtual_of(root, relative)
            tag = row.get(".tag")
            if tag == "deleted":
                _drop_below(seen, relative)
                found.append((FileChangeKind.DELETE, virtual))
                continue
            version = (
                ""
                if tag == "folder"
                else str(row.get("content_hash") or row.get("rev") or "")
            )
            previous = seen.get(relative)
            seen[relative] = version
            if previous is None:
                found.append((FileChangeKind.CREATE, virtual))
            elif previous != version:
                found.append((FileChangeKind.UPDATE, virtual))
        return Delta(
            tuple(changes_under(root, found, observed)), _encode(cursor, seen)
        )


def build_delta_hook(accessor: DropboxAccessor) -> DeltaHook:
    """Build the Dropbox delta hook.

    Args:
        accessor (DropboxAccessor): Backend handle.
    """
    return DropboxDeltaHook(accessor)
