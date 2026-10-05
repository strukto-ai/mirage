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
import logging
import re
import threading
from collections.abc import Iterator
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


@dataclass
class FakeBox:
    """Box's folder, file and content routes on a local port.

    Serves what a read, a stat, a listing and the fresh probe reach:
    ``/2.0/folders/{id}/items``, ``/2.0/files/{id}`` (only the fields its
    ``fields`` query asks for, plus ``type`` and ``id``), and
    ``/2.0/files/{id}/content``, which 302s to ``/dl/{id}`` the way Box
    sends a download to its content host. Every write keeps
    ``modified_at``, so two same-size edits land in one second and only
    ``sha1`` tells them apart, as on the real service.

    Args:
        files (dict[str, bytes]): path under All Files to bytes.
        log (list[str]): ``route:id`` for every request (``items``,
            ``info``, ``content``, ``dl``).
        url (str): the origin ``serve`` sets once it is listening.
        forbidden (set[str]): ids whose ``GET /files/{id}`` answers 403.
        unhashed (set[str]): ids Box renders with no ``sha1``.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    url: str = ""
    forbidden: set[str] = field(default_factory=set)
    unhashed: set[str] = field(default_factory=set)
    items: dict[str, _Item] = field(default_factory=dict)

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

    def write(self, path: str, data: bytes) -> None:
        item = self._find(path)
        assert item is not None and not item.folder, path
        item.data = data

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
            "etag": "1",
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
        if item is None or item.folder or item.status != "active":
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
        if self._readable(file_id) is None:
            return web.json_response({"code": "not_found"}, status=404)
        raise web.HTTPFound(f"{self.url}/dl/{file_id}")

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
    app.router.add_get("/2.0/files/{id}", box.file_info)
    app.router.add_get("/2.0/files/{id}/content", box.content)
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
