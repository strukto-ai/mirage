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

from collections.abc import Sequence

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.client import list_collections
from mirage.core.mongodb.types import (
    KIND_TO_DIR,
    SYSTEM_DATABASES,
    EntityKind,
)
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec

# Change events that rewrite a collection's documents.jsonl.
_DATA_EVENTS = frozenset({"insert", "update", "replace", "delete"})

# Change events that rewrite a collection's schema.json.
_SCHEMA_EVENTS = frozenset({"createIndexes", "dropIndexes", "modify"})

# Change events that change which collections and views a database
# lists, so its views must be listed again.
_LISTING_EVENTS = frozenset({"create", "drop", "rename", "modify"})

_COLLECTIONS = KIND_TO_DIR[EntityKind.COLLECTION]
_VIEWS = KIND_TO_DIR[EntityKind.VIEW]


class MongoDBEventHook:
    """Map one MongoDB change stream event onto mount paths.

    The consumer owns the stream (``watch()`` on the client or one
    database, with ``show_expanded_events`` so collection and index
    changes come through) and its resume token, and passes each event's
    ``operationType`` with the event. Nothing here runs a loop.

    A collection is one ``documents.jsonl`` and one ``schema.json``, so
    an event says exactly which files moved: a document written or
    removed rewrites its collection's documents.jsonl and the schema.json
    sampled from it, and both files of every view in that database (a
    view reads other collections); an index or validator change rewrites
    its schema.json, and a view's new pipeline (its ``modify`` names
    ``viewOn``) both of the view's files; a collection created, dropped
    or renamed is its directory appearing or leaving, and its database's
    database.json, which lists it. A dropped database leaves, and an
    invalidated stream leaves the whole mount UNKNOWN. The views of a
    database are listed once and listed again after any event that
    changes what the database holds.
    """

    def __init__(self, accessor: MongoDBAccessor) -> None:
        """Args:
        accessor (MongoDBAccessor): Backend handle.
        """
        self._accessor = accessor
        self._views: dict[str, list[str]] = {}

    async def _views_of(self, db: str) -> list[str]:
        """The views ``db`` holds, listed once until it changes.

        Args:
            db (str): The database.
        """
        if db not in self._views:
            self._views[db] = await list_collections(
                self._accessor.client, db, EntityKind.VIEW
            )
        return self._views[db]

    async def to_events(
        self, root: PathSpec, operation_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one change event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            operation_type (str): The event's ``operationType``.
            payload (JsonValue): The change event.
        """
        if operation_type == "invalidate":
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        ns = field(payload, "ns")
        db, name = text_field(ns, "db"), text_field(ns, "coll")
        allowed = self._accessor.config.databases
        if (
            db is None
            or db in SYSTEM_DATABASES
            or (allowed and db not in allowed)
        ):
            return ()
        if operation_type == "dropDatabase":
            self._views.pop(db, None)
            return (event_at(root, db, FileChangeKind.DELETE),)
        if name is None:
            return ()
        details = field(payload, "operationDescription")
        changed: dict[str, FileChangeKind] = {}
        place = f"{db}/{_COLLECTIONS}/{name}"
        if operation_type in _LISTING_EVENTS:
            self._views.pop(db, None)
        if operation_type in _DATA_EVENTS:
            changed[f"{place}/documents.jsonl"] = FileChangeKind.UPDATE
            changed[f"{place}/schema.json"] = FileChangeKind.UPDATE
            for view in await self._views_of(db):
                for file in ("documents.jsonl", "schema.json"):
                    changed[f"{db}/{_VIEWS}/{view}/{file}"] = (
                        FileChangeKind.UPDATE
                    )
        elif (
            operation_type == "modify" and field(details, "viewOn") is not None
        ):
            view = f"{db}/{_VIEWS}/{name}"
            changed[f"{view}/schema.json"] = FileChangeKind.UPDATE
            changed[f"{view}/documents.jsonl"] = FileChangeKind.UPDATE
        elif operation_type in _SCHEMA_EVENTS:
            changed[f"{place}/schema.json"] = FileChangeKind.UPDATE
        elif operation_type == "create":
            dirname = (
                _VIEWS
                if field(details, "viewOn") is not None
                else _COLLECTIONS
            )
            changed[f"{db}/{dirname}/{name}"] = FileChangeKind.CREATE
            changed[f"{db}/database.json"] = FileChangeKind.UPDATE
        elif operation_type == "drop":
            changed[place] = FileChangeKind.DELETE
            changed[f"{db}/{_VIEWS}"] = FileChangeKind.UNKNOWN
            changed[f"{db}/database.json"] = FileChangeKind.UPDATE
        elif operation_type == "rename":
            to = field(payload, "to")
            changed[place] = FileChangeKind.DELETE
            changed[f"{db}/database.json"] = FileChangeKind.UPDATE
            target_db, target = text_field(to, "db"), text_field(to, "coll")
            if target_db is not None and target is not None:
                self._views.pop(target_db, None)
                changed[f"{target_db}/{_COLLECTIONS}/{target}"] = (
                    FileChangeKind.CREATE
                )
                changed[f"{target_db}/database.json"] = FileChangeKind.UPDATE
        return tuple(
            event_at(root, path, kind) for path, kind in changed.items()
        )
