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
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.events.base import DeltaHook
from mirage.events.delta import changes_under, just_made, settle
from mirage.events.payload import text_field
from mirage.types import Delta, FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def feed_state(checkpoint: str | None) -> dict[str, Any] | None:
    """What a Drive change-feed checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous read handed out.
    """
    if checkpoint is None:
        return None
    data = json.loads(checkpoint)
    state = data.get("drive") if isinstance(data, dict) else None
    if not isinstance(state, dict) or not isinstance(state.get("token"), str):
        return None
    return state


def feed_checkpoint(state: dict[str, Any]) -> str:
    """Encode a Drive change-feed checkpoint.

    Args:
        state (dict[str, Any]): The page token, the paths seen by id and
            whatever else the hook keeps.
    """
    return json.dumps({"drive": state}, sort_keys=True)


class AppDeltaHook:
    """Checkpointed delta of a Google app mount over Drive's change feed.

    Drive pings a channel with no body, so a ping reads ``changes.list``
    from the page token the last read handed out, keeping the changes to
    the app's files. Each is placed as the app lists it: in ``owned`` or
    ``shared`` by its first owner, named by its title, id and modified
    day. The checkpoint keeps the path of each file a read placed, so an
    edit on another day or a new title moves it from the name it had,
    and a file deleted, trashed or no longer shared leaves it. A file
    seen for the first time is created when it is as Drive made it (its
    created and modified times agree) and updated otherwise; the name it
    had before is left to the corpus listing the update evicts.
    """

    def __init__(
        self,
        accessor: GoogleApiAccessor,
        mime: str,
        make_filename: Callable[[str, str, str], str],
    ) -> None:
        """Args:
        accessor (GoogleApiAccessor): Backend handle.
        mime (str): The Drive MIME type the app's files carry.
        make_filename (Callable[[str, str, str], str]): The app's file
            name from a title, a file id and a modified time.
        """
        self._accessor = accessor
        self._mime = mime
        self._make_filename = make_filename

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root.
            checkpoint (str | None): The previous read's state, or None
                for a baseline.
        """
        drive = self._accessor.drive
        observed = datetime.now(timezone.utc)
        state = feed_state(checkpoint)
        if state is None:
            token = await drive.start_page_token()
            return Delta(
                (),
                feed_checkpoint({"token": token, "seen": {}}),
            )
        found, token = await drive.list_changes(state["token"])
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        seen: dict[str, str] = dict(state.get("seen") or {})
        changes: list[tuple[FileChangeKind, str]] = []
        for change in found:
            item_id = text_field(change, "fileId")
            if item_id is None:
                continue
            item = change.get("file")
            if (
                not isinstance(item, dict)
                or item.get("mimeType") != self._mime
            ):
                if change.get("removed"):
                    settle(changes, seen, item_id, None, False)
                continue
            path = self._path(prefix, item)
            if change.get("removed") or item.get("trashed"):
                seen.setdefault(item_id, path)
                settle(changes, seen, item_id, None, False)
                continue
            made = just_made(item.get("createdTime"), item.get("modifiedTime"))
            settle(changes, seen, item_id, path, made)
        events = changes_under(root, changes, observed)
        return Delta(
            tuple(events),
            feed_checkpoint({"token": token, "seen": seen}),
        )

    def _path(self, prefix: str, item: dict[str, Any]) -> str:
        """Where the app lists ``item``.

        Args:
            prefix (str): The mount's prefix.
            item (dict[str, Any]): The changed file.
        """
        owners = item.get("owners") or [{}]
        corpus = "owned" if owners[0].get("me", False) else "shared"
        name = self._make_filename(
            item["name"], item["id"], item.get("modifiedTime", "")
        )
        return f"{prefix}/{corpus}/{name}"


def app_delta_hook(
    accessor: GoogleApiAccessor,
    mime: str,
    make_filename: Callable[[str, str, str], str],
) -> DeltaHook:
    """The delta hook of a Google app mount (``AppDeltaHook``).

    Args:
        accessor (GoogleApiAccessor): Backend handle.
        mime (str): The Drive MIME type the app's files carry.
        make_filename (Callable[[str, str, str], str]): The app's file
            name from a title, a file id and a modified time.
    """
    return AppDeltaHook(accessor, mime, make_filename)
