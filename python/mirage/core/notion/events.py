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
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.normalize import (
    data_source_segment_name,
    database_segment_name,
    page_segment_name,
)
from mirage.core.notion.pages import get_data_source, get_database, get_page
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.utils.key_prefix import under_path

logger = logging.getLogger(__name__)

_GONE = frozenset({"page.deleted", "database.deleted", "data_source.deleted"})
_MADE = frozenset(
    {
        "page.created",
        "page.undeleted",
        "database.created",
        "database.undeleted",
        "data_source.created",
        "data_source.undeleted",
    }
)
_PLACED = frozenset(
    {
        "page.properties_updated",
        "page.moved",
        "database.moved",
        "database.schema_updated",
        "data_source.moved",
        "data_source.schema_updated",
    }
)
_OWN_FILES = {
    "page": ("page.json",),
    "database": ("database.json",),
    "data_source": ("data_source.json", "rows.jsonl"),
}


def _rows_of(place: str | None) -> str | None:
    """The ``rows.jsonl`` a page's directory is a row of, or None.

    A row is the only page directly below a data source, which is the
    only directory two levels below ``databases``.

    Args:
        place (str | None): A page's directory.
    """
    if place is None:
        return None
    parts = place.split("/")
    if len(parts) != 4 or parts[0] != "databases":
        return None
    return "/".join(parts[:3]) + "/rows.jsonl"


def _parent(place: str) -> str:
    """The directory holding ``place``.

    Args:
        place (str): A mount-relative directory.
    """
    return place.rsplit("/", 1)[0]


class NotionEventHook:
    """Map one Notion webhook event onto mount paths.

    The consumer owns the subscription's endpoint and passes the event's
    ``type`` with its body. Nothing here runs a loop. An event names its
    entity by id only, so each place is read from Notion: a page by its
    parent chain up to the workspace or a data source, a data source
    through its database. Each place is remembered, so a later event on
    the same page or one below it costs nothing, and a move, rename or
    delete forgets what was below the old place.

    A page is a directory holding ``page.json``, below ``pages`` when it
    is a workspace page, below another page, or below a data source as a
    row. A page inside some other block is not listed, so it maps to
    nothing, as does one the integration cannot read up to the top.
    ``page.json`` renders the page's properties and blocks, so a content
    or property change updates it, and a row's line in its data source's
    ``rows.jsonl`` carries the same properties and edit time.

    A page made or restored creates its ``page.json``, and one deleted
    deletes its directory. A page's directory carries its title, so a
    move or a retitle moves everything below it, which the event does
    not list: the old place, when the hook saw it, and the new one are
    UNKNOWN. A move of one it never saw has an old place nothing names,
    so the whole mount is UNKNOWN, and a retitle of a page it never saw
    is UNKNOWN on the page's parent. Databases and data sources follow
    the same rules with ``database.json`` and ``data_source.json``; a
    data source's rows changing updates ``rows.jsonl``, and a database
    lists its data sources, so a data source made, moved, retitled or
    deleted also updates ``database.json``. Comments are rendered
    nowhere.
    """

    def __init__(self, accessor: NotionAccessor) -> None:
        """Args:
        accessor (NotionAccessor): Backend handle, used to read the
            places events name.
        """
        self._accessor = accessor
        self._places: dict[str, str | None] = {}

    async def _read(
        self,
        read: Callable[..., Awaitable[dict[str, Any]]],
        object_id: str,
    ) -> dict[str, Any] | None:
        """One object, or None when Notion has none the integration
        can read.

        Args:
            read (Callable[..., Awaitable[dict[str, Any]]]): The getter.
            object_id (str): The object's id.
        """
        try:
            return await read(
                self._accessor.config, object_id, session=self._accessor.pool
            )
        except NotionAPIError as exc:
            if exc.status != 404:
                raise
            logger.debug(
                "notion events: %s is not readable: %s", object_id, exc
            )
            return None

    async def _place(
        self, kind: str, object_id: str, fresh: bool = False
    ) -> str | None:
        """Where a page, database or data source is on the mount,
        remembered.

        Args:
            kind (str): ``page``, ``database`` or ``data_source``.
            object_id (str): Its id.
            fresh (bool): Read it again rather than trust the memo.
        """
        if not fresh and object_id in self._places:
            return self._places[object_id]
        place: str | None = None
        if kind == "database":
            database = await self._read(get_database, object_id)
            if database is not None:
                place = f"databases/{database_segment_name(database)}"
        elif kind == "data_source":
            source = await self._read(get_data_source, object_id)
            owner = text_field(field(source, "parent"), "database_id")
            above = await self._place("database", owner) if owner else None
            if source is not None and above is not None:
                place = f"{above}/{data_source_segment_name(source)}"
        else:
            page = await self._read(get_page, object_id)
            above = await self._page_parent(page)
            if page is not None and above is not None:
                place = f"{above}/{page_segment_name(page)}"
        self._places[object_id] = place
        return place

    async def _page_parent(self, page: JsonValue) -> str | None:
        """The directory a page is listed in, or None when none is.

        Args:
            page (JsonValue): The page object.
        """
        parent = field(page, "parent")
        kind = text_field(parent, "type")
        if kind == "workspace":
            return "pages"
        if kind == "page_id":
            above = text_field(parent, "page_id")
            return await self._place("page", above) if above else None
        if kind == "data_source_id":
            above = text_field(parent, "data_source_id")
            return await self._place("data_source", above) if above else None
        return None

    def _forget(self, place: str) -> None:
        """Drop every remembered place at or below one that moved.

        Args:
            place (str): The old place.
        """
        for object_id, known in list(self._places.items()):
            if known is not None and under_path(known, place):
                del self._places[object_id]

    def _companions(
        self, root: PathSpec, kind: str, places: Sequence[str | None]
    ) -> list[FileEvent]:
        """The files beside an entity that list it: a row's
        ``rows.jsonl`` and a data source's ``database.json``.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            kind (str): ``page``, ``database`` or ``data_source``.
            places (Sequence[str | None]): The entity's places.
        """
        found: list[str] = []
        for place in places:
            if place is None:
                continue
            beside = (
                _rows_of(place)
                if kind == "page"
                else f"{_parent(place)}/database.json"
                if kind == "data_source"
                else None
            )
            if beside is not None and beside not in found:
                found.append(beside)
        return [event_at(root, path, FileChangeKind.UPDATE) for path in found]

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one webhook event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The event's ``type``.
            payload (JsonValue): The event body.
        """
        kind, _, change = event_type.partition(".")
        object_id = text_field(field(payload, "entity"), "id")
        if object_id is None or kind not in (
            "page",
            "database",
            "data_source",
        ):
            return ()
        own = _OWN_FILES[kind]
        if event_type in _GONE:
            place = await self._place(kind, object_id)
            if place is None:
                return ()
            self._forget(place)
            return (
                event_at(root, place, FileChangeKind.DELETE),
                *self._companions(root, kind, [place]),
            )
        if event_type in _MADE:
            place = await self._place(kind, object_id, fresh=True)
            if place is None:
                return ()
            return (
                *(
                    event_at(root, f"{place}/{name}", FileChangeKind.CREATE)
                    for name in own
                ),
                *self._companions(root, kind, [place]),
            )
        if event_type in _PLACED:
            was = self._places.get(object_id)
            now = await self._place(kind, object_id, fresh=True)
            events: list[FileEvent] = []
            if was is None and change == "moved" and kind != "database":
                events.append(event_at(root, "", FileChangeKind.UNKNOWN))
            if was is not None and was != now:
                self._forget(was)
                events.append(event_at(root, was, FileChangeKind.UNKNOWN))
                if now is not None:
                    self._places[object_id] = now
            if now is None:
                return (*events, *self._companions(root, kind, [was]))
            properties = field(field(payload, "data"), "updated_properties")
            retitled = isinstance(properties, list) and "title" in properties
            if (
                (was is not None and was != now)
                or change == "schema_updated"
                or (change == "moved" and kind != "database")
            ):
                events.append(event_at(root, now, FileChangeKind.UNKNOWN))
            elif was is None and retitled:
                events.append(
                    event_at(root, _parent(now), FileChangeKind.UNKNOWN)
                )
            else:
                events.append(
                    event_at(root, f"{now}/{own[0]}", FileChangeKind.UPDATE)
                )
            return (*events, *self._companions(root, kind, [was, now]))
        if change != "content_updated":
            return ()
        place = await self._place(kind, object_id)
        if place is None:
            return ()
        if kind == "page":
            return (
                event_at(root, f"{place}/page.json", FileChangeKind.UPDATE),
                *self._companions(root, kind, [place]),
            )
        if kind == "data_source":
            return (
                event_at(root, f"{place}/rows.jsonl", FileChangeKind.UPDATE),
            )
        return (event_at(root, place, FileChangeKind.UNKNOWN),)
