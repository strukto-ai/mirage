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
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from pymongo.errors import OperationFailure

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.client import drain_changes, list_collections
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.types import (
    CHANGE_STREAM_UNSUPPORTED,
    HISTORY_LOST,
    KIND_TO_DIR,
    NOT_A_REPLICA_SET,
    SYSTEM_DATABASES,
    EntityKind,
)
from mirage.errors.fs import enotsup
from mirage.types import Delta, FileChangeKind, FileEvent, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import spec_for

logger = logging.getLogger(__name__)

# Change events that rewrite a collection's documents.jsonl.
_DATA_EVENTS = frozenset({"insert", "update", "replace", "delete"})

# Change events that rewrite a collection's schema.json.
_SCHEMA_EVENTS = frozenset({"createIndexes", "dropIndexes", "modify"})

_COLLECTIONS = KIND_TO_DIR[EntityKind.COLLECTION]
_VIEWS = KIND_TO_DIR[EntityKind.VIEW]


def _encode(token: Mapping[str, Any] | None) -> str:
    return json.dumps({"mongodb": dict(token or {})}, sort_keys=True)


def _decode(checkpoint: str | None) -> Mapping[str, Any] | None:
    """The stream position a checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    data = json.loads(checkpoint)
    token = data.get("mongodb") if isinstance(data, dict) else None
    return token if isinstance(token, dict) and token else None


def _removed(changed: dict[str, FileChangeKind], place: str) -> None:
    """Record a directory removed, and forget what changed below it.

    Args:
        changed (dict[str, FileChangeKind]): The changes so far, by path.
        place (str): The directory removed.
    """
    for key in [k for k in changed if k.startswith(place + "/")]:
        del changed[key]
    changed[place] = FileChangeKind.DELETE


class MongoDBDeltaHook:
    """Checkpointed delta over a MongoDB change stream.

    A collection is one ``documents.jsonl`` and one ``schema.json``, so
    the stream says exactly which files moved: a document written or
    removed rewrites its collection's documents.jsonl and every view's
    in that database (a view reads other collections), an index or
    validator change its schema.json, and a collection created, dropped
    or renamed is its directory appearing or leaving. The checkpoint is
    the stream's resume token. A position the server's history no longer
    holds answers UNKNOWN on the watch root, so everything below is
    inventoried again. A server outside a replica set has no change
    stream and refuses the watch.
    """

    def __init__(self, accessor: MongoDBAccessor) -> None:
        """Args:
        accessor (MongoDBAccessor): Backend handle.
        """
        self._accessor = accessor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): The previous pull's resume token, or
                None for a baseline.
        """
        database = detect_scope(root).slots.get("database")
        token = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        client = self._accessor.client
        try:
            events, position = await drain_changes(client, database, token)
        except OperationFailure as exc:
            if exc.code in (CHANGE_STREAM_UNSUPPORTED, NOT_A_REPLICA_SET):
                raise enotsup("mongodb", "watch", root) from exc
            if exc.code != HISTORY_LOST or token is None:
                raise
            logger.debug("mongodb watch lost its position: %s", exc)
            _, position = await drain_changes(client, database, None)
            lost = FileEvent(
                kind=FileChangeKind.UNKNOWN, path=root, timestamp=observed
            )
            return Delta((lost,), _encode(position))
        if token is None:
            return Delta((), _encode(position))
        changes = await self._changes(root, events, observed)
        return Delta(changes, _encode(position))

    async def _changes(
        self,
        root: PathSpec,
        events: list[dict[str, Any]],
        observed: datetime,
    ) -> tuple[FileEvent, ...]:
        """The files ``events`` changed under ``root``, each once.

        Args:
            root (PathSpec): Watch root.
            events (list[dict[str, Any]]): Change events, in order.
            observed (datetime): Timestamp every change carries.
        """
        prefix = mount_prefix_of(root.virtual, root.vfs_path).rstrip("/")
        allowed = self._accessor.config.databases
        changed: dict[str, FileChangeKind] = {}
        written: set[str] = set()
        for event in events:
            ns = event.get("ns") or {}
            db, name = ns.get("db"), ns.get("coll")
            if (
                not isinstance(db, str)
                or db in SYSTEM_DATABASES
                or (allowed and db not in allowed)
            ):
                continue
            base = f"{prefix}/{db}"
            kind = event.get("operationType")
            if kind == "dropDatabase":
                _removed(changed, base)
                continue
            if not isinstance(name, str):
                continue
            place = f"{base}/{_COLLECTIONS}/{name}"
            if kind in _DATA_EVENTS:
                changed[f"{place}/documents.jsonl"] = FileChangeKind.UPDATE
                written.add(db)
            elif kind in _SCHEMA_EVENTS:
                changed[f"{place}/schema.json"] = FileChangeKind.UPDATE
            elif kind == "create":
                details = event.get("operationDescription") or {}
                dirname = _VIEWS if "viewOn" in details else _COLLECTIONS
                changed[f"{base}/{dirname}/{name}"] = FileChangeKind.CREATE
            elif kind == "drop":
                _removed(changed, place)
                changed[f"{base}/{_VIEWS}"] = FileChangeKind.UNKNOWN
            elif kind == "rename":
                to = event.get("to") or {}
                _removed(changed, place)
                if isinstance(to.get("db"), str) and isinstance(
                    to.get("coll"), str
                ):
                    moved = f"{prefix}/{to['db']}/{_COLLECTIONS}/{to['coll']}"
                    changed[moved] = FileChangeKind.CREATE
        for db in sorted(written):
            client = self._accessor.client
            for view in await list_collections(client, db, EntityKind.VIEW):
                file = f"{prefix}/{db}/{_VIEWS}/{view}/documents.jsonl"
                changed.setdefault(file, FileChangeKind.UPDATE)
        top = root.virtual.rstrip("/")
        return tuple(
            FileEvent(
                kind=kind, path=spec_for(root, virtual), timestamp=observed
            )
            for virtual, kind in changed.items()
            if virtual == top or virtual.startswith(top + "/")
        )


def build_delta_hook(accessor: MongoDBAccessor) -> DeltaHook:
    """Build the MongoDB delta hook (``MongoDBDeltaHook``).

    Args:
        accessor (MongoDBAccessor): Backend handle.
    """
    return MongoDBDeltaHook(accessor)
