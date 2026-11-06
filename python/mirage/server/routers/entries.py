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


import re
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from mirage.resources.base import ResourceStore
from mirage.resources.constants import ENTRY_KINDS, NAME, NOUN
from mirage.resources.errors import ResourceError
from mirage.resources.types import Entry, EntryInput, EntryKind, Fields
from mirage.server.resources.fields import types_of
from mirage.server.resources.refs import uses
from mirage.server.resources.values import check_values, stores_of
from mirage.server.routers.templates import (
    require_one_account,
    store_refusal,
)
from mirage.types import JsonValue

# Each kind's route, as the console names it.
ROUTES: dict[EntryKind, str] = {
    "vfs": "/v1/vfs",
    "cli": "/v1/clis",
    "runtime": "/v1/runtimes",
}

# A name the console reads as an id, which it refuses as a name.
ID_PREFIX = re.compile(r"(ws|sec|pol|key|tpl|team|usr)_")


class Refused(Exception):
    """A request the console answers with a 4xx and extra keys beside
    ``detail``."""

    def __init__(self, status: int, detail: str, **extra: JsonValue) -> None:
        super().__init__(detail)
        self.status = status
        self.extra = extra

    def answer(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status,
            content={"detail": str(self), **self.extra},
        )


def present(
    kind: EntryKind, entry: Entry, used_by: int | None = None
) -> dict[str, Any]:
    """An entry as the console answers it. The daemon keeps no id,
    creator or times, so the id is the name and the rest are null.

    Args:
        kind (EntryKind): the entry's kind.
        entry (Entry): the entry.
        used_by (int | None): how many templates name it, for a list.
    """
    out: dict[str, Any] = {
        "id": entry.name,
        "name": entry.name,
        "kind": kind,
        "type": entry.type,
        "builtin": False,
        "config": entry.fields,
    }
    if kind == "runtime":
        out["captures"] = []
    out.update(created_by=None, created_at=None, updated_at=None)
    if used_by is not None:
        out["used_by"] = used_by
    return out


def required_string(body: dict[str, JsonValue], key: str) -> str:
    value = body.get(key)
    if value is not None and not isinstance(value, str):
        raise Refused(400, f"{key} must be a string")
    if not value:
        raise Refused(400, f"{key} is required")
    return value


def check_name(kind: EntryKind, name: str) -> str:
    if NAME.fullmatch(name) is None or ID_PREFIX.match(name) is not None:
        raise Refused(
            400,
            f"{NOUN[kind]} name must be 1-63 of a-z 0-9 . _ -, start with "
            "a letter or digit, and not look like an id",
        )
    return name


async def json_body(request: Request) -> dict[str, JsonValue]:
    try:
        body = await request.json()
    except ValueError:
        raise Refused(400, "body must be JSON") from None
    if not isinstance(body, dict):
        raise Refused(400, "body must be a JSON object")
    return body


async def entry_named(
    store: ResourceStore, kind: EntryKind, ref: str
) -> Entry:
    """The entry of ``kind`` named ``ref``, refused as the console
    refuses a missing one.

    Args:
        store (ResourceStore): the saved configs.
        kind (EntryKind): the route's kind.
        ref (str): the entry's name.
    """
    try:
        return await store.get_entry(kind, ref)
    except ResourceError as e:
        if e.code in ("not_found", "invalid"):
            raise Refused(404, f"{NOUN[kind]} not found") from e
        raise


async def require_stores(store: ResourceStore, config: Fields) -> None:
    """Refuse fields pointing at a store that is not saved.

    Args:
        store (ResourceStore): the saved configs.
        config (Fields): the entry's plain fields.
    """
    saved = {e.name for e in await store.list_entries("store")}
    missing = [s for s in stores_of(config) if s not in saved]
    if missing:
        raise Refused(
            400,
            f"add {', '.join(missing)} under Secret stores first",
            missing=list(missing),
        )


async def exists(store: ResourceStore, name: str) -> bool:
    for kind in ENTRY_KINDS:
        try:
            await store.get_entry(kind, name)
        except ResourceError as e:
            if e.code != "not_found":
                raise
            continue
        return True
    return False


def removed_by(given: JsonValue) -> set[str]:
    """The fields an edit removes: given as null, or now pointing at a
    store, whose sealed value would be read instead.

    Args:
        given (JsonValue): the body's ``fields``.
    """
    if not isinstance(given, dict):
        return set()
    return {k for k, v in given.items() if v is None or isinstance(v, dict)}


def entry_router(kind: EntryKind) -> APIRouter:
    """The routes of one kind of entry, as the console serves them: the
    route sets the kind, so an entry answers only under its own. Sealed
    fields are write-only; no route answers with one.

    Args:
        kind (EntryKind): the entry kind.
    """
    router = APIRouter(
        prefix=ROUTES[kind], dependencies=[Depends(require_one_account)]
    )

    @router.get("", response_model=None)
    async def list_entries(
        request: Request, type: str | None = None, q: str | None = None
    ) -> Response | dict[str, Any]:
        store: ResourceStore = request.app.state.resources
        try:
            entries = await store.list_entries(kind)
            used = await uses(store)
        except ResourceError as e:
            raise store_refusal(e) from e
        text = (q or "").strip().lower()
        return {
            "items": [
                present(kind, e, len(used.get(e.name, [])))
                for e in entries
                if (not type or e.type == type)
                and (not text or text in e.name.lower())
            ]
        }

    @router.get("/types")
    async def list_types() -> dict[str, Any]:
        return dict(types_of(kind))

    @router.post("", status_code=201, response_model=None)
    async def create_entry(request: Request) -> Response | dict[str, Any]:
        store: ResourceStore = request.app.state.resources
        try:
            body = await json_body(request)
            type = required_string(body, "type")
            checked = check_values(
                kind, type, body.get("fields"), types_of(kind)
            )
            name = check_name(kind, required_string(body, "name"))
            await require_stores(store, checked.config)
            if await exists(store, name):
                raise Refused(409, f"{name} already exists")
            saved = await store.put_entry(
                kind,
                EntryInput(
                    name=name,
                    type=type,
                    fields=checked.config,
                    sealed=dict(checked.sealed),
                ),
            )
        except Refused as e:
            return e.answer()
        except ResourceError as e:
            raise store_refusal(e) from e
        return present(kind, saved)

    @router.get("/{ref}", response_model=None)
    async def get_entry(
        ref: str, request: Request
    ) -> Response | dict[str, Any]:
        store: ResourceStore = request.app.state.resources
        try:
            entry = await entry_named(store, kind, ref)
        except Refused as e:
            return e.answer()
        except ResourceError as e:
            raise store_refusal(e) from e
        return {**present(kind, entry), "sealed": entry.sealed}

    @router.put("/{ref}", response_model=None)
    async def update_entry(
        ref: str, request: Request
    ) -> Response | dict[str, Any]:
        store: ResourceStore = request.app.state.resources
        try:
            body = await json_body(request)
            current = await entry_named(store, kind, ref)
            given = body.get("fields")
            removed = removed_by(given)
            kept = frozenset(current.sealed) - removed
            checked = check_values(
                kind, current.type, given, types_of(kind), kept
            )
            await require_stores(store, checked.config)
            sealed: dict[str, JsonValue | None] = {k: None for k in removed}
            sealed.update(checked.sealed)
            saved = await store.put_entry(
                kind,
                EntryInput(
                    name=current.name,
                    type=current.type,
                    fields=checked.config,
                    sealed=sealed,
                ),
            )
        except Refused as e:
            return e.answer()
        except ResourceError as e:
            raise store_refusal(e) from e
        return present(kind, saved)

    @router.delete("/{ref}", status_code=204, response_model=None)
    async def delete_entry(ref: str, request: Request) -> Response:
        store: ResourceStore = request.app.state.resources
        try:
            current = await entry_named(store, kind, ref)
            used_by = (await uses(store)).get(current.name, [])
            if used_by:
                raise Refused(
                    409, f"{current.name} is used by {', '.join(used_by)}"
                )
            await store.delete_entry(kind, current.name)
        except Refused as e:
            return e.answer()
        except ResourceError as e:
            raise store_refusal(e) from e
        return Response(status_code=204)

    return router


ROUTERS: list[APIRouter] = [entry_router(kind) for kind in ROUTES]
