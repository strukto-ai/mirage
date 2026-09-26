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
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, unquote

from aiohttp import web

ME = "me"
SITE_ID = "contoso.sharepoint.com,site-1,web-1"
SITE_NAME = "Main"
DRIVE_ID = "b!drive-1"
DRIVE_NAME = "Documents"
BYTE_ROUTES = ("download", "content", "version_content")


@dataclass
class _Row:
    data: bytes
    ctag: str
    etag: str
    modified: str
    versions: list[dict[str, Any]] = field(default_factory=list)
    history: dict[str, bytes] = field(default_factory=dict)


@dataclass
class FakeGraph:
    """Microsoft Graph drives on a local port, for tests that need the wire.

    Speaks the item, children, content and version routes both drive
    backends address (``/me/drive/root:/{path}`` for OneDrive,
    ``/drives/{id}/root:/{path}`` for SharePoint), plus the sites search
    and drives listing SharePoint resolves names through.

    Graph semantics the repo cannot measure (no live account) are modelled
    conservatively rather than guessed:

    - A content write mints a new cTag ``c<n>`` and eTag ``e<n>``, strictly
      increasing and never reused; ``touch`` moves only the eTag and the
      modified stamp, as a metadata edit does.
    - ``@microsoft.graph.downloadUrl`` is live: it serves whatever the row
      holds when the download arrives, not the version the item GET saw.
      Under a pinned URL a token read before the bytes is trivially safe;
      only a live one can tell token-before-bytes from bytes-before-token.
    - ``/content`` answers 200 with the bytes, so no client has to follow
      the 302 real Graph sends.
    - ``/versions/{id}/content`` serves the bytes that version was written
      with, and 404s an id the item never had, so a pinned read after a
      rewrite gets the old content.

    Args:
        drives (dict): drive id (``me`` for OneDrive) to ``{path: bytes}``.
        log (list): ``(route, path, query)`` for every request.
        reach (list): requests no read or stat should make.
        children_allowed (int): children listings not counted as reach.
    """

    drives: dict[str, dict[str, bytes]] = field(default_factory=dict)
    log: list[tuple[str, str, str]] = field(default_factory=list)
    reach: list[str] = field(default_factory=list)
    children_allowed: int = 0
    hook_fired: int = 0
    url: str = ""
    _rows: dict[tuple[str, str], _Row] = field(default_factory=dict)
    _seq: int = 0
    _on_bytes: Callable[[], None] | None = None

    def __post_init__(self) -> None:
        for drive, files in self.drives.items():
            for path, data in files.items():
                self.write(drive, path, data)

    def count(self, route: str) -> int:
        return sum(1 for name, _, _ in self.log if name == route)

    def fetches(self) -> int:
        return sum(self.count(route) for route in BYTE_ROUTES)

    def queries(self, route: str) -> list[str]:
        return [query for name, _, query in self.log if name == route]

    def _mint(self) -> int:
        self._seq += 1
        return self._seq

    def write(self, drive: str, path: str, data: bytes) -> None:
        n = self._mint()
        stamp = f"2026-01-01T00:00:{n:02d}Z"
        row = self._rows.get((drive, path))
        versions = list(row.versions) if row is not None else []
        history = dict(row.history) if row is not None else {}
        version = f"{len(versions) + 1}.0"
        versions.append({"id": version, "lastModifiedDateTime": stamp})
        history[version] = data
        self._rows[(drive, path)] = _Row(data=data,
                                         ctag=f"c{n}",
                                         etag=f"e{n}",
                                         modified=stamp,
                                         versions=versions,
                                         history=history)

    def touch(self, drive: str, path: str) -> None:
        row = self._rows[(drive, path)]
        n = self._mint()
        row.etag = f"e{n}"
        row.modified = f"2026-01-01T00:00:{n:02d}Z"

    def ctag(self, drive: str, path: str) -> str:
        return self._rows[(drive, path)].ctag

    def etag(self, drive: str, path: str) -> str:
        return self._rows[(drive, path)].etag

    def on_bytes(self, fn: Callable[[], None]) -> None:
        self._on_bytes = fn

    def _item(self, drive: str, path: str,
              request: web.Request | None) -> dict[str, Any] | None:
        row = self._rows.get((drive, path))
        name = path.rsplit("/", 1)[-1]
        if row is not None:
            item: dict[str, Any] = {
                "id":
                f"{drive}:{path}",
                "name":
                name,
                "size":
                len(row.data),
                "file": {},
                "cTag":
                row.ctag,
                "eTag":
                row.etag,
                "lastModifiedDateTime":
                row.modified,
                "@microsoft.graph.downloadUrl":
                f"{self.url}/download/{quote(drive, safe='')}/{quote(path)}",
            }
            if (request is not None
                    and "versions" in request.query.get("$expand", "")):
                item["versions"] = list(reversed(row.versions))
            return item
        under = path + "/" if path else ""
        kids = self._children(drive, path)
        if path and not kids:
            return None
        size = sum(
            len(r.data) for (d, p), r in self._rows.items()
            if d == drive and p.startswith(under))
        return {
            "id": f"{drive}:{path}/",
            "name": name or "root",
            "size": size,
            "folder": {
                "childCount": len(kids)
            },
            "cTag": f"cf:{path}",
            "eTag": f"ef:{path}",
            "lastModifiedDateTime": "2026-01-01T00:00:00Z",
        }

    def _children(self, drive: str, path: str) -> list[str]:
        under = path + "/" if path else ""
        names: set[str] = set()
        for d, p in self._rows:
            if d == drive and p.startswith(under):
                names.add(under + p[len(under):].split("/", 1)[0])
        return sorted(names)

    async def handle(self, request: web.Request) -> web.StreamResponse:
        tail = request.match_info["tail"]
        query = unquote(request.query_string)
        parts = tail.split("/")
        if parts[0] == "sites" and len(parts) == 1:
            return self._sites(query)
        if parts[0] == "sites" and len(parts) == 3 and parts[2] == "drives":
            return self._site_drives(parts[1], query)
        if parts[0] == "download" and len(parts) >= 3:
            self.log.append(("download", "/".join(parts[2:]), query))
            return self._bytes(request, parts[1], "/".join(parts[2:]))
        if parts[:2] == ["me", "drive"]:
            return self._drive(request, ME, "/".join(parts[2:]), query)
        if parts[0] == "drives" and len(parts) >= 2:
            return self._drive(request, parts[1], "/".join(parts[2:]), query)
        return self._unrouted(tail, query)

    def _unrouted(self, tail: str, query: str) -> web.Response:
        self.log.append(("unrouted", tail, query))
        self.reach.append(f"unrouted {tail}")
        return _error(404, "invalidRequest", f"no route for {tail}")

    def _sites(self, query: str) -> web.Response:
        self.log.append(("sites", "", query))
        if self.count("sites") > 1:
            self.reach.append("sites listed twice")
        return web.json_response({
            "value": [{
                "id": SITE_ID,
                "name": SITE_NAME.lower(),
                "displayName": SITE_NAME
            }]
        })

    def _site_drives(self, site: str, query: str) -> web.Response:
        self.log.append(("drives", site, query))
        if self.count("drives") > 1:
            self.reach.append("drives listed twice")
        if site != SITE_ID:
            return _error(404, "itemNotFound", "no such site")
        return web.json_response(
            {"value": [{
                "id": DRIVE_ID,
                "name": DRIVE_NAME
            }]})

    def _drive(self, request: web.Request, drive: str, rest: str,
               query: str) -> web.StreamResponse:
        if rest == "root":
            path, action = "", ""
        elif rest == "root/children":
            path, action = "", "/children"
        elif rest.startswith("root:/"):
            path, _, action = rest[len("root:/"):].partition(":")
        else:
            return self._unrouted(rest, query)
        if action == "":
            self.log.append(("item", path, query))
            item = self._item(drive, path, request)
            if item is None:
                return _error(404, "itemNotFound", "The resource could "
                              "not be found.")
            return web.json_response(item)
        if action == "/children":
            self.log.append(("children", path, query))
            if self.count("children") > self.children_allowed:
                self.reach.append(f"children of {path or '/'}")
            if self._item(drive, path, request) is None:
                return _error(404, "itemNotFound", "no such folder")
            items = [
                self._item(drive, child, None)
                for child in self._children(drive, path)
            ]
            return web.json_response({"value": items})
        if action == "/content":
            self.log.append(("content", path, query))
            return self._bytes(request, drive, path)
        if action.startswith("/versions/") and action.endswith("/content"):
            self.log.append(("version_content", path, query))
            version = action[len("/versions/"):-len("/content")]
            return self._bytes(request, drive, path, version)
        if action == "/delta":
            self.log.append(("delta", path, query))
            self.reach.append("delta")
            return web.json_response({"value": []})
        return self._unrouted(rest, query)

    def _bytes(self,
               request: web.Request,
               drive: str,
               path: str,
               version: str | None = None) -> web.Response:
        row = self._rows.get((drive, path))
        if row is None:
            return _error(404, "itemNotFound", "no such item")
        if version is not None and version not in row.history:
            return _error(404, "itemNotFound", "no such version")
        data = row.data if version is None else row.history[version]
        # The store changes after the body is taken and before a byte of it
        # is written, so the next request, whatever it is, already sees the
        # new row; no thread timing can reorder the two.
        hook, self._on_bytes = self._on_bytes, None
        if hook is not None:
            self.hook_fired += 1
            hook()
        span = request.headers.get("Range", "")
        if span.startswith("bytes="):
            first, _, last = span[len("bytes="):].partition("-")
            end = int(last) + 1 if last else len(data)
            return web.Response(status=206, body=data[int(first):end])
        return web.Response(body=data)


def _error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {
        "code": code,
        "message": message
    }},
                             status=status)


@contextmanager
def serve(graph: FakeGraph | None = None) -> Iterator[FakeGraph]:
    """Run ``graph`` on its own thread and loop, and yield it with ``url`` set.

    A thread of its own lets a test on ``asyncio.run`` and a test on the
    pytest loop share one fake, the way ThreadedMotoServer does for s3.

    Args:
        graph (FakeGraph | None): the fake to serve; a fresh empty one if
            None.
    """
    graph = graph or FakeGraph()
    app = web.Application()
    app.router.add_get("/v1.0/{tail:.*}", graph.handle)
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(app)

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        graph.url = f"http://127.0.0.1:{port}/v1.0"

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait()
    try:
        yield graph
    finally:
        asyncio.run_coroutine_threadsafe(runner.cleanup(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
