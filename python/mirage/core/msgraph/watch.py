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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from typing import Any

from mirage.core.api.client import SessionArg
from mirage.core.msgraph.client import (
    GraphError,
    encoded_path,
    graph_get,
    id_segment,
)
from mirage.core.msgraph.config import MsGraphConfig
from mirage.types import Delta, FileChangeKind, PathSpec
from mirage.watch.delta import (
    changes_under,
    folder_path,
    just_made,
    moved_below,
    settle,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DeltaTarget:
    """One drive a watch reads, and where its mount root sits.

    Args:
        drive (str): The drive's Graph URL.
        folder (str): The mount root's path from the drive root, "" for
            the drive root itself.
        virtual (str): The mount root's virtual path.
    """

    drive: str
    folder: str
    virtual: str


class GraphDeltaHook:
    """Checkpointed delta over Graph's ``/delta`` feed, one per drive.

    Graph pings a subscription with no description of the change, so a
    ping reads each drive's feed from the link the last read handed out.
    The feed names an item by id with its name and parent, never its
    path, so the hook places it by its parents up to the mount root,
    keeping each folder it has looked up (name and parent, by id) in the
    checkpoint, where the folders' own changes keep them current; an
    item whose parents never reach the root is outside the mount. The
    checkpoint also keeps the path of each item a read placed: one that
    moves leaves that path, with everything below a folder, and one
    deleted leaves it. An item seen for the first time is created when it
    is as Graph made it (its created and modified times agree) and
    updated otherwise; one deleted
    before any read placed it names nothing, and is left to the index's
    expiry. A feed Graph asks to resync reports its mount root as
    unknown and starts again from the present.
    """

    def __init__(
        self,
        config: MsGraphConfig,
        session: SessionArg,
        targets: Callable[[PathSpec], Awaitable[list[DeltaTarget]]],
    ) -> None:
        """Args:
        config (MsGraphConfig): The account's Graph config.
        session (SessionArg): The pool requests ride.
        targets (Callable[[PathSpec], Awaitable[list[DeltaTarget]]]):
            The drives a watch on a root reads.
        """
        self._config = config
        self._session = session
        self._targets = targets

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): The previous read's state, or None
                for a baseline.
        """
        observed = datetime.now(timezone.utc)
        state = _decode(checkpoint)
        if state is None:
            drives: dict[str, dict[str, Any]] = {}
            for target in await self._targets(root):
                drives[target.drive] = {
                    "virtual": target.virtual,
                    "top": await self._top(target),
                    "link": await self._latest(target.drive),
                    "folders": {},
                    "seen": {},
                }
            return Delta((), _encode(drives))
        changes: list[tuple[FileChangeKind, str]] = []
        for drive, kept in state["drives"].items():
            await self._read(drive, kept, changes)
        return Delta(
            tuple(changes_under(root, changes, observed)),
            _encode(state["drives"]),
        )

    async def _read(
        self,
        drive: str,
        kept: dict[str, Any],
        changes: list[tuple[FileChangeKind, str]],
    ) -> None:
        """Read one drive's feed into ``changes`` and move ``kept`` on.

        Args:
            drive (str): The drive's Graph URL.
            kept (dict[str, Any]): What the checkpoint holds for it.
            changes (list[tuple[FileChangeKind, str]]): The changes so far.
        """
        virtual = str(kept["virtual"])
        try:
            items, kept["link"] = await self._feed(str(kept["link"]))
        except GraphError as exc:
            if exc.status != HTTPStatus.GONE:
                raise
            logger.debug("graph feed of %s must resync: %s", drive, exc)
            changes.append((FileChangeKind.UNKNOWN, virtual))
            kept["link"] = await self._latest(drive)
            return
        top = str(kept["top"])
        folders: dict[str, list[str]] = kept["folders"]
        seen: dict[str, str] = kept["seen"]
        look_up = partial(self._look_up, drive)
        for item in items:
            item_id = item.get("id")
            if not isinstance(item_id, str):
                continue
            gone = "deleted" in item
            if item_id == top:
                if gone:
                    changes.append((FileChangeKind.DELETE, virtual))
                continue
            if "root" in item:
                continue
            if item_id not in seen and item_id in folders:
                placed = await folder_path(item_id, top, folders, look_up)
                if placed is not None:
                    seen[item_id] = _join(virtual, placed)
            parent = (item.get("parentReference") or {}).get("id") or ""
            if "folder" in item and not gone:
                folders[item_id] = [str(item.get("name", "")), parent]
            elif gone:
                folders.pop(item_id, None)
            now = None
            if not gone and parent:
                base = (
                    ""
                    if parent == top
                    else await folder_path(parent, top, folders, look_up)
                )
                if base is not None:
                    name = str(item.get("name", ""))
                    now = _join(virtual, f"{base}/{name}" if base else name)
            made = just_made(
                item.get("createdDateTime"), item.get("lastModifiedDateTime")
            )
            was = settle(changes, seen, item_id, now, made)
            if was is not None and was != now:
                moved_below(seen, was, now)

    async def _feed(self, link: str) -> tuple[list[dict[str, Any]], str]:
        """Every item a feed link lists, and the link the next read
        starts from.

        Args:
            link (str): Where the last read ended.
        """
        items: list[dict[str, Any]] = []
        url = link
        while True:
            data = await graph_get(self._config, url, session=self._session)
            items.extend(
                i for i in data.get("value", []) if isinstance(i, dict)
            )
            if data.get("@odata.deltaLink"):
                return items, str(data["@odata.deltaLink"])
            url = str(data["@odata.nextLink"])

    async def _latest(self, drive: str) -> str:
        """A feed link at the drive's present, which lists nothing.

        Args:
            drive (str): The drive's Graph URL.
        """
        data = await graph_get(
            self._config,
            f"{drive}/root/delta",
            params={"token": "latest"},
            session=self._session,
        )
        return str(data["@odata.deltaLink"])

    async def _top(self, target: DeltaTarget) -> str:
        """The id of the folder the mount root is.

        Args:
            target (DeltaTarget): The drive and the root's place in it.
        """
        folder = target.folder.strip("/")
        url = (
            f"{target.drive}/root:/{encoded_path(folder)}"
            if folder
            else f"{target.drive}/root"
        )
        data = await graph_get(
            self._config, url, params={"$select": "id"}, session=self._session
        )
        return str(data["id"])

    async def _look_up(self, drive: str, folder_id: str) -> list[str] | None:
        """A folder's name and parent id, None when it is gone; the drive
        root has no parent on a mount rooted below it.

        Args:
            drive (str): The drive's Graph URL.
            folder_id (str): The folder's id.
        """
        try:
            item = await graph_get(
                self._config,
                f"{drive}/items/{id_segment(folder_id)}",
                params={"$select": "id,name,parentReference,root"},
                session=self._session,
            )
        except GraphError as exc:
            if exc.status != HTTPStatus.NOT_FOUND:
                raise
            logger.debug("graph folder %s is gone: %s", folder_id, exc)
            return None
        if "root" in item:
            return ["", ""]
        parent = (item.get("parentReference") or {}).get("id") or ""
        return [str(item.get("name", "")), parent]


def _join(virtual: str, relative: str) -> str:
    """The virtual path of a path below a mount root.

    Args:
        virtual (str): The mount root's virtual path.
        relative (str): The path below it, "" for the root.
    """
    if not relative:
        return virtual
    return f"{virtual.rstrip('/')}/{relative}"


def _encode(drives: dict[str, dict[str, Any]]) -> str:
    return json.dumps({"graph": {"drives": drives}}, sort_keys=True)


def _decode(checkpoint: str | None) -> dict[str, Any] | None:
    """What a checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous read handed out.
    """
    if checkpoint is None:
        return None
    data = json.loads(checkpoint)
    state = data.get("graph") if isinstance(data, dict) else None
    if not isinstance(state, dict) or not isinstance(
        state.get("drives"), dict
    ):
        return None
    return state
