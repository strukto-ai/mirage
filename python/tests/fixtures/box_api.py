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

import asyncio
import hashlib
import itertools
import json
import logging
import re
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import Future
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

from aiohttp import web

logger = logging.getLogger(__name__)

MODIFIED = "2026-01-01T00:00:00Z"
DeleteMode = Literal["purge", "trash", "trash_ancestor"]
Status = Literal["active", "trash", "trash_ancestor"]
ALL_FILES = "0"


def sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


@dataclass
class _Item:
    id: str
    name: str
    parent: str | None
    folder: bool
    data: bytes = b""
    status: Status = "active"
    version: int = 1
    link: bool = False


@dataclass
class FakeBox:
    """Box's folder, file and content routes on a local port.

    Serves what a read, a stat, a listing and the fresh probe reach:
    ``/2.0/folders/{id}/items``, ``/2.0/files/{id}`` (only the fields its
    ``fields`` query asks for, plus ``type`` and ``id``), and
    ``/2.0/files/{id}/content``, which 302s to ``/dl/{id}`` the way Box
    sends a download to its content host. The two upload routes,
    ``POST /2.0/files/content`` (new) and ``POST /2.0/files/{id}/content``
    (version), answer ``{total_count: 1, entries: [file]}`` with the file
    rendered by ``_row``, the renderer listings and info use, so an upload
    reply's sha1 and a later stat's cannot disagree. Every write keeps
    ``modified_at``, so two same-size edits land in one second and only
    ``sha1`` tells them apart, as on the real service.

    Args:
        files (dict[str, bytes]): path under All Files to bytes.
        log (list[str]): ``route:id`` for every request (``items``,
            ``info``, ``content``, ``dl``, ``upload``; an upload logs the
            parent id for a new file and the file id for a version).
        url (str): the origin ``serve`` sets once it is listening.
        forbidden (set[str]): ids whose ``GET /files/{id}`` or
            ``DELETE /web_links/{id}`` answers 403.
        unhashed (set[str]): ids Box renders with no ``sha1``.
        hooks (dict[str, Callable[[], None]]): one-shot callbacks run when
            the named route (``content``, ``upload``, ``delete``, ``update``,
            ``copy``)
            is reached, before it acts: another writer landing between
            mirage's lookup and its request.

    A file's ``etag`` is its version, bumped by every content write, and
    ``If-Match`` on an upload or delete answers 412 ``precondition_failed``
    when it differs, as Box does (measured 2026-10-05 for uploads,
    2026-10-08 for deletes). A request onto a taken name answers 409
    ``item_name_in_use`` naming the item that holds it in
    ``context_info.conflicts``, as Box does (measured 2026-10-08).
    """

    files: dict[str, bytes] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    url: str = ""
    forbidden: set[str] = field(default_factory=set)
    unhashed: set[str] = field(default_factory=set)
    items: dict[str, _Item] = field(default_factory=dict)
    hooks: dict[str, Callable[[], None]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._ids = itertools.count(100)
        self.items[ALL_FILES] = _Item(ALL_FILES, "All Files", None, True)
        for path, data in self.files.items():
            self.create(path, data)

    def count(self, route: str) -> int:
        return sum(1 for r in self.log if r.split(":", 1)[0] == route)

    def _kids(self, parent: str) -> list[_Item]:
        return [
            i
            for i in self.items.values()
            if i.parent == parent and i.status == "active"
        ]

    def _find(self, path: str) -> _Item | None:
        cur = self.items[ALL_FILES]
        for name in [p for p in path.split("/") if p]:
            nxt = next((k for k in self._kids(cur.id) if k.name == name), None)
            if nxt is None:
                return None
            cur = nxt
        return cur

    def id_of(self, path: str) -> str:
        item = self._find(path)
        assert item is not None, path
        return item.id

    def _folder(self, path: str) -> _Item:
        cur = self.items[ALL_FILES]
        for name in [p for p in path.split("/") if p]:
            nxt = next(
                (k for k in self._kids(cur.id) if k.name == name and k.folder),
                None,
            )
            if nxt is None:
                nxt = _Item(str(next(self._ids)), name, cur.id, True)
                self.items[nxt.id] = nxt
            cur = nxt
        return cur

    def create(self, path: str, data: bytes) -> str:
        parent, _, name = path.strip("/").rpartition("/")
        folder = self._folder(parent)
        item = _Item(str(next(self._ids)), name, folder.id, False, data)
        self.items[item.id] = item
        return item.id

    def create_link(self, path: str) -> str:
        parent, _, name = path.strip("/").rpartition("/")
        folder = self._folder(parent)
        item = _Item(str(next(self._ids)), name, folder.id, False, link=True)
        self.items[item.id] = item
        return item.id

    def write(self, path: str, data: bytes) -> None:
        item = self._find(path)
        assert item is not None and not item.folder, path
        item.data = data
        item.version += 1

    def read(self, path: str) -> bytes | None:
        item = self._find(path)
        return None if item is None or item.folder else item.data

    def move(self, path: str, to: str) -> None:
        item = self._find(path)
        assert item is not None, path
        parent, _, name = to.strip("/").rpartition("/")
        item.parent = self._folder(parent).id
        item.name = name

    def rename_folder(self, path: str, name: str) -> None:
        item = self._find(path)
        assert item is not None and item.folder, path
        item.name = name

    def delete(self, path: str, mode: DeleteMode) -> None:
        """Remove ``path`` the way Box can answer for it afterwards.

        Args:
            path (str): the item under All Files.
            mode (DeleteMode): ``purge`` (404 not_found), ``trash`` (404
                trashed), or ``trash_ancestor`` (descendants 404 not_found).
        """
        # Tests are not type-checked, so the wire spelling "trashed" must
        # fail here: as a status it would drop the item from listings while
        # GET /files/{id} still answered it active.
        assert mode in get_args(DeleteMode), mode
        item = self._find(path)
        assert item is not None, path
        if mode == "purge":
            del self.items[item.id]
        else:
            item.status = mode

    def _chain(self, item: _Item) -> list[dict[str, Any]]:
        chain: list[_Item] = []
        cur = self.items.get(item.parent or "")
        while cur is not None:
            chain.append(cur)
            cur = self.items.get(cur.parent or "")
        chain.reverse()
        return [{"type": "folder", "id": a.id, "name": a.name} for a in chain]

    def _row(self, item: _Item) -> dict[str, Any]:
        if item.link:
            return {
                "type": "web_link",
                "id": item.id,
                "name": item.name,
                "etag": "0",
            }
        if item.folder:
            return {
                "type": "folder",
                "id": item.id,
                "name": item.name,
                "modified_at": MODIFIED,
                "etag": "0",
            }
        chain = self._chain(item)
        row: dict[str, Any] = {
            "type": "file",
            "id": item.id,
            "name": item.name,
            "size": len(item.data),
            "modified_at": MODIFIED,
            "etag": str(item.version),
            "parent": {"type": "folder", "id": item.parent},
            "item_status": "active",
            "path_collection": {"total_count": len(chain), "entries": chain},
        }
        if item.id not in self.unhashed:
            row["sha1"] = sha1(item.data)
        return row

    def _listable(self, folder_id: str) -> bool:
        item = self.items.get(folder_id)
        if item is None or not item.folder:
            return False
        cur: _Item | None = item
        while cur is not None:
            if cur.status != "active":
                return False
            cur = self.items.get(cur.parent or "")
        return True

    def _readable(self, file_id: str) -> _Item | None:
        item = self.items.get(file_id)
        if item is None or item.folder or item.link or item.status != "active":
            return None
        return item

    async def folder_items(self, req: web.Request) -> web.Response:
        folder_id = req.match_info["id"]
        self.log.append(f"items:{folder_id}")
        if not self._listable(folder_id):
            return web.json_response({"code": "not_found"}, status=404)
        rows = [self._row(k) for k in self._kids(folder_id)]
        if "fields" in req.query:
            asked = set(req.query["fields"].split(",")) | {
                "type",
                "id",
                "etag",
                "sequence_id",
                "name",
                "sha1",
                "file_version",
            }
            rows = [
                {k: v for k, v in row.items() if k in asked} for row in rows
            ]
        return web.json_response(
            {"entries": rows, "total_count": len(rows), "offset": 0}
        )

    async def create_folder(self, req: web.Request) -> web.Response:
        body = await req.json()
        parent = body["parent"]["id"]
        self.log.append(f"mkdir:{parent}")
        if not self._listable(parent):
            return self._refuse(404, "not_found")
        if (taken := self._taken(parent, body["name"])) is not None:
            return self._name_in_use(taken)
        folder = _Item(str(next(self._ids)), body["name"], parent, True)
        self.items[folder.id] = folder
        return web.json_response(self._row(folder), status=201)

    async def folder_info(self, req: web.Request) -> web.Response:
        folder_id = req.match_info["id"]
        self.log.append(f"folder:{folder_id}")
        if not self._listable(folder_id):
            return self._refuse(404, "not_found")
        return web.json_response(self._row(self.items[folder_id]))

    async def file_info(self, req: web.Request) -> web.Response:
        file_id = req.match_info["id"]
        self.log.append(f"info:{file_id}")
        if file_id in self.forbidden:
            return web.json_response({"code": "forbidden"}, status=403)
        item = self.items.get(file_id)
        if item is None or item.folder:
            return web.json_response({"code": "not_found"}, status=404)
        if item.status == "trash":
            return web.json_response({"code": "trashed"}, status=404)
        if not self._listable(item.parent or ""):
            return web.json_response({"code": "not_found"}, status=404)
        row = self._row(item)
        asked = set(req.query.get("fields", "").split(",")) | {"type", "id"}
        return web.json_response({k: v for k, v in row.items() if k in asked})

    async def content(self, req: web.Request) -> web.Response:
        file_id = req.match_info["id"]
        self.log.append(f"content:{file_id}")
        self._hook("content")
        item = self._readable(file_id)
        if item is None:
            return web.json_response({"code": "not_found"}, status=404)
        raise web.HTTPFound(f"{self.url}/dl/{item.id}")

    async def _upload_form(self, req: web.Request) -> tuple[dict, bytes]:
        form = await req.post()
        attributes = json.loads(str(form["attributes"]))
        part = form["file"]
        assert isinstance(part, web.FileField), part
        return attributes, part.file.read()

    def _uploaded(self, item: _Item, status: int) -> web.Response:
        return web.json_response(
            {"total_count": 1, "entries": [self._row(item)]}, status=status
        )

    def _hook(self, route: str) -> None:
        hook = self.hooks.pop(route, None)
        if hook is not None:
            hook()

    def _taken(self, parent: str, name: str, own: str = "") -> _Item | None:
        return next(
            (k for k in self._kids(parent) if k.name == name and k.id != own),
            None,
        )

    @staticmethod
    def _name_in_use(item: _Item) -> web.Response:
        kind = "web_link" if item.link else "folder" if item.folder else "file"
        conflict = {"type": kind, "id": item.id, "name": item.name}
        return web.json_response(
            {
                "code": "item_name_in_use",
                "context_info": {"conflicts": [conflict]},
            },
            status=409,
        )

    def _precondition(self, req: web.Request, item: _Item) -> bool:
        want = req.headers.get("If-Match")
        return want is not None and want != str(item.version)

    @staticmethod
    def _refuse(status: int, code: str) -> web.Response:
        return web.json_response({"code": code}, status=status)

    async def upload_new(self, req: web.Request) -> web.Response:
        attributes, data = await self._upload_form(req)
        parent_id = attributes["parent"]["id"]
        self.log.append(f"upload:{parent_id}")
        self._hook("upload")
        if (taken := self._taken(parent_id, attributes["name"])) is not None:
            return self._name_in_use(taken)
        item = _Item(
            str(next(self._ids)), attributes["name"], parent_id, False, data
        )
        self.items[item.id] = item
        return self._uploaded(item, 201)

    async def upload_version(self, req: web.Request) -> web.Response:
        file_id = req.match_info["id"]
        _, data = await self._upload_form(req)
        self.log.append(f"upload:{file_id}")
        self._hook("upload")
        item = self._readable(file_id)
        if item is None:
            return self._refuse(404, "not_found")
        if self._precondition(req, item):
            return self._refuse(412, "precondition_failed")
        item.data = data
        item.version += 1
        return self._uploaded(item, 200)

    def _drop(self, item: _Item) -> None:
        for kid in [k for k in self.items.values() if k.parent == item.id]:
            self._drop(kid)
        del self.items[item.id]

    async def delete_file(self, req: web.Request) -> web.Response:
        file_id = req.match_info["id"]
        self.log.append(f"delete:{file_id}")
        self._hook("delete")
        item = self._readable(file_id)
        if item is None:
            return self._refuse(404, "not_found")
        if self._precondition(req, item):
            return self._refuse(412, "precondition_failed")
        self._drop(item)
        return web.Response(status=204)

    async def delete_link(self, req: web.Request) -> web.Response:
        link_id = req.match_info["id"]
        self.log.append(f"delete:{link_id}")
        self._hook("delete")
        if link_id in self.forbidden:
            return self._refuse(403, "forbidden")
        item = self.items.get(link_id)
        if item is None or not item.link:
            return self._refuse(404, "not_found")
        del self.items[link_id]
        return web.Response(status=204)

    async def delete_folder(self, req: web.Request) -> web.Response:
        folder_id = req.match_info["id"]
        self.log.append(f"delete:{folder_id}")
        self._hook("delete")
        if not self._listable(folder_id):
            return self._refuse(404, "not_found")
        recursive = req.query.get("recursive") == "true"
        if not recursive and self._kids(folder_id):
            return self._refuse(409, "folder_not_empty")
        self._drop(self.items[folder_id])
        return web.Response(status=204)

    async def update(self, req: web.Request) -> web.Response:
        item_id = req.match_info["id"]
        self.log.append(f"update:{item_id}")
        self._hook("update")
        item = self.items.get(item_id)
        if item is None or item.status != "active":
            return self._refuse(404, "not_found")
        body = await req.json()
        parent = body.get("parent", {}).get("id", item.parent)
        name = body.get("name", item.name)
        if (taken := self._taken(parent, name, own=item.id)) is not None:
            return self._name_in_use(taken)
        item.parent, item.name = parent, name
        return web.json_response(self._row(item))

    def _clone(self, item: _Item, parent: str, name: str) -> _Item:
        twin = _Item(
            str(next(self._ids)), name, parent, item.folder, item.data
        )
        self.items[twin.id] = twin
        for kid in self._kids(item.id):
            self._clone(kid, twin.id, kid.name)
        return twin

    async def copy(self, req: web.Request) -> web.Response:
        item_id = req.match_info["id"]
        self.log.append(f"copy:{item_id}")
        self._hook("copy")
        item = self.items.get(item_id)
        if item is None or item.status != "active":
            return self._refuse(404, "not_found")
        body = await req.json()
        parent = body["parent"]["id"]
        name = body.get("name", item.name)
        if (taken := self._taken(parent, name)) is not None:
            return self._name_in_use(taken)
        return web.json_response(
            self._row(self._clone(item, parent, name)), status=201
        )

    async def dl(self, req: web.Request) -> web.Response:
        file_id = req.match_info["id"]
        self.log.append(f"dl:{file_id}")
        item = self._readable(file_id)
        if item is None:
            return web.Response(status=404)
        data = item.data
        match = re.fullmatch(
            r"bytes=(\d+)-(\d*)", req.headers.get("Range", "")
        )
        if match is None:
            return web.Response(body=data)
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else len(data) - 1
        end = min(end, len(data) - 1)
        return web.Response(
            status=206,
            body=data[start : end + 1],
            headers={"Content-Range": f"bytes {start}-{end}/{len(data)}"},
        )


@contextmanager
def serve(box: FakeBox | None = None) -> Iterator[FakeBox]:
    """Run ``box`` on its own thread and loop, with ``url`` set.

    Args:
        box (FakeBox | None): the fake to serve; a fresh empty one if None.
    """
    box = box or FakeBox()
    app = web.Application()
    app.router.add_get("/2.0/folders/{id}/items", box.folder_items)
    app.router.add_post("/2.0/folders", box.create_folder)
    app.router.add_get("/2.0/folders/{id}", box.folder_info)
    app.router.add_get("/2.0/files/{id}", box.file_info)
    app.router.add_get("/2.0/files/{id}/content", box.content)
    app.router.add_post("/2.0/files/content", box.upload_new)
    app.router.add_post("/2.0/files/{id}/content", box.upload_version)
    app.router.add_delete("/2.0/files/{id}", box.delete_file)
    app.router.add_delete("/2.0/folders/{id}", box.delete_folder)
    app.router.add_delete("/2.0/web_links/{id}", box.delete_link)
    app.router.add_put("/2.0/files/{id}", box.update)
    app.router.add_put("/2.0/folders/{id}", box.update)
    app.router.add_post("/2.0/files/{id}/copy", box.copy)
    app.router.add_post("/2.0/folders/{id}/copy", box.copy)
    app.router.add_get("/dl/{id}", box.dl)
    loop = asyncio.new_event_loop()
    startup: Future[None] = Future()
    finished: Future[None] = Future()
    runner = web.AppRunner(app)

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        box.url = f"http://127.0.0.1:{port}"

    def run() -> None:
        asyncio.set_event_loop(loop)
        started = False
        try:
            loop.run_until_complete(start())
            started = True
            startup.set_result(None)
            loop.run_forever()
        except BaseException as exc:
            if not started:
                startup.set_exception(exc)
            else:
                finished.set_exception(exc)
        finally:
            try:
                loop.run_until_complete(runner.cleanup())
            except BaseException as exc:
                if started and not finished.done():
                    finished.set_exception(exc)
                else:
                    logger.debug("cleanup after Box fake failure: %s", exc)
            finally:
                loop.close()
                if not finished.done():
                    finished.set_result(None)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    started = False
    failure: BaseException | None = None
    try:
        startup.result()
        started = True
        yield box
    except BaseException as exc:
        failure = exc
        raise
    finally:
        if started:
            loop.call_soon_threadsafe(loop.stop)
        thread.join()
        try:
            finished.result()
        except BaseException as exc:
            if failure is None:
                raise
            logger.debug("cleanup after Box fake failure: %s", exc)
