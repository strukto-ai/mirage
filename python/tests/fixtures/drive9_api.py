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
import base64
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from urllib.parse import unquote

from aiohttp import web
from multidict import MultiDictProxy

MTIME = 1792965402
TOKEN = "fs-token"


def _parent(path: str) -> str:
    return path.rsplit("/", 1)[0] or "/"


def _missing(status: int = 404, message: str = "not found") -> web.Response:
    return web.json_response({"error": message}, status=status)


@dataclass
class Upload:
    path: str
    total: int
    parts: dict[int, bytes] = field(default_factory=dict)


@dataclass
class FakeDrive9:
    """A drive9 file system on a local port, for tests that need the wire.

    Answers the calls the tidb_filesystem mount makes the way drive9-server
    does (measured against mem9-ai/drive9 1f1ff16f with a local TiDB,
    2026-10-25): a file and a directory of one name live side by side, a
    write, a mkdir and a file rename make missing parents, a listing of a
    missing folder is empty, GET on a directory is 404, a plain PUT of
    ``inline_threshold`` bytes or more is refused, a large file reads as
    a 302 to its object, and only a large file takes ``?append``, whose
    plan copies the parts it keeps and hands out a read URL for the one
    it rewrites. Presigned objects are served on ``localhost``
    while the API is on ``127.0.0.1``, a different origin, and refuse a
    request that carries the bearer token, as object storage refuses two
    credentials.

    Args:
        files (dict): path to bytes.
        dirs (set): directory paths; ``/`` is implicit.
        extent (set): file paths in the extent layout, which a read
            answers 422.
        part_size (int): the multipart part size handed out.
        busy_deletes (int): recursive deletes answered 503 before one
            goes through.
        fail_parts (bool): every part upload answers 500.
        part_delay (float): seconds each part upload takes, so ``peak``
            shows how many run at once.
        drop_read_urls (bool): an append plan names no read URL.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    dirs: set[str] = field(default_factory=set)
    extent: set[str] = field(default_factory=set)
    part_size: int = 8 * 1024 * 1024
    inline_threshold: int = 50_000
    busy_deletes: int = 0
    fail_parts: bool = False
    part_delay: float = 0.0
    drop_read_urls: bool = False
    in_flight: int = 0
    peak: int = 0
    url: str = ""
    object_url: str = ""
    requests: list[tuple[str, str]] = field(default_factory=list)
    uploads: dict[str, Upload] = field(default_factory=dict)
    leaked: list[str] = field(default_factory=list)

    def count(self, method: str, route: str = "") -> int:
        return sum(
            1 for m, r in self.requests if m == method and r.startswith(route)
        )

    def _authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _make_parents(self, path: str) -> None:
        parent = _parent(path)
        while parent != "/":
            self.dirs.add(parent)
            parent = _parent(parent)

    def _is_dir(self, path: str) -> bool:
        return path == "/" or path in self.dirs

    def _entry(
        self, path: str, prefer_dir: bool = False
    ) -> dict[str, int | bool] | None:
        if not prefer_dir and path in self.files:
            return {"size": len(self.files[path]), "isDir": False}
        if self._is_dir(path):
            return {"size": 0, "isDir": True}
        return None

    def _under(self, path: str) -> list[str]:
        prefix = path.rstrip("/") + "/"
        return [p for p in (*self.files, *self.dirs) if p.startswith(prefix)]

    async def fs(self, request: web.Request) -> web.StreamResponse:
        raw = "/" + unquote(request.match_info["path"])
        path = raw.rstrip("/") or "/"
        query = request.query
        action = next(iter(query), "")
        self.requests.append((request.method, f"{path}?{action}"))
        if not self._authorized(request):
            return _missing(401, "unauthorized")
        if request.method == "HEAD":
            entry = self._entry(path, prefer_dir=raw.endswith("/"))
            if entry is None or (raw.endswith("/") and not entry["isDir"]):
                return web.Response(status=404)
            body = b"" if entry["isDir"] else self.files[path]
            return web.Response(
                body=body,
                headers={
                    "X-Dat9-IsDir": "true" if entry["isDir"] else "false",
                    "X-Dat9-Mtime": str(MTIME),
                },
            )
        if request.method == "GET" and "list" in query:
            return self._list(path)
        if request.method == "GET":
            return self._read(path)
        if request.method == "PUT":
            data = await request.read()
            if len(data) >= self.inline_threshold:
                return _missing(400, "missing X-Dat9-Part-Checksums header")
            self._make_parents(path)
            self.files[path] = data
            return web.json_response({"status": "ok", "revision": 1})
        if request.method == "DELETE":
            return self._delete(path, query)
        if request.method == "POST" and "mkdir" in query:
            if path in self.files or self._is_dir(path):
                return _missing(409, "path already exists")
            self._make_parents(path)
            self.dirs.add(path)
            return web.json_response({"status": "ok"})
        if request.method == "POST" and "rename" in query:
            return self._rename(request, path)
        if request.method == "POST" and "append" in query:
            return await self._append(request, path)
        return _missing(400, "unknown POST action")

    async def _append(self, request: web.Request, path: str) -> web.Response:
        data = self.files.get(path)
        if data is None:
            return _missing(404, f'stat append target "{path}": not found')
        if len(data) < self.inline_threshold:
            return _missing(400, f"file is not S3-stored: {path}")
        body = await request.json()
        base = len(data)
        total = base + body["append_size"]
        size = self.part_size
        kept = -(-base // size)
        dirty = [kept] if base % size else []
        dirty += range(kept + 1, -(-total // size) + 1)
        upload_id = f"up{len(self.uploads) + 1}"
        upload = Upload(path, total)
        for number in range(1, kept + 1):
            if number not in dirty:
                start = (number - 1) * size
                upload.parts[number] = data[start : start + size]
        rows: list[dict[str, str | int | dict[str, str]]] = []
        for number in dirty:
            start = (number - 1) * size
            row: dict[str, str | int | dict[str, str]] = {
                "number": number,
                "url": f"{self.object_url}/s3/upload/{upload_id}/{number}",
                "size": min(size, total - start),
            }
            if number <= kept and not self.drop_read_urls:
                end = min(start + size, base) - 1
                row["read_url"] = f"{self.object_url}/s3/objects{path}"
                row["read_headers"] = {"Range": f"bytes={start}-{end}"}
            rows.append(row)
        self.uploads[upload_id] = upload
        return web.json_response(
            {
                "upload_id": upload_id,
                "part_size": size,
                "base_size": base,
                "upload_parts": rows,
                "copied_parts": sorted(upload.parts),
            },
            status=202,
        )

    def _list(self, path: str) -> web.Response:
        prefix = path.rstrip("/") + "/"
        rows = []
        for child in sorted(self.files):
            if _parent(child) == path and child.startswith(prefix):
                rows.append(
                    {
                        "name": child[len(prefix) :],
                        "size": len(self.files[child]),
                        "isDir": False,
                        "mtime": MTIME,
                    }
                )
        for child in sorted(self.dirs):
            if _parent(child) == path and child.startswith(prefix):
                rows.append(
                    {
                        "name": child[len(prefix) :],
                        "size": 0,
                        "isDir": True,
                        "mtime": MTIME,
                    }
                )
        return web.json_response({"entries": rows})

    def _read(self, path: str) -> web.Response:
        if path in self.extent:
            return web.json_response(
                {"error": "extent content is not served inline"},
                status=422,
                headers={"X-Dat9-Content-Layout": "extent"},
            )
        if path not in self.files:
            return _missing()
        data = self.files[path]
        if len(data) >= self.inline_threshold:
            location = f"{self.object_url}/s3/objects{path}"
            raise web.HTTPFound(location)
        return web.Response(body=data)

    def _delete(self, path: str, query: MultiDictProxy[str]) -> web.Response:
        if "recursive" in query:
            if self.busy_deletes > 0:
                self.busy_deletes -= 1
                return web.json_response(
                    {"error": "busy"}, status=503, headers={"Retry-After": "0"}
                )
            if path in self.files:
                del self.files[path]
                return web.json_response({"status": "ok"})
            if path not in self.dirs:
                return _missing()
            for child in self._under(path):
                self.files.pop(child, None)
                self.dirs.discard(child)
            self.dirs.discard(path)
            return web.json_response({"status": "ok"})
        kind = query.get("kind")
        if kind == "file":
            if path not in self.files:
                return _missing()
            del self.files[path]
            return web.json_response({"status": "ok"})
        if path not in self.dirs:
            return _missing()
        if self._under(path):
            return _missing(409, f"directory not empty: {path}/")
        self.dirs.discard(path)
        return web.json_response({"status": "ok"})

    def _rename(self, request: web.Request, dst: str) -> web.Response:
        header = request.headers.get("X-Dat9-Rename-Source", "")
        if request.headers.get("X-Dat9-Path-Encoding") == "base64url":
            padded = header + "=" * (-len(header) % 4)
            header = base64.urlsafe_b64decode(padded).decode()
        src = header.rstrip("/") or "/"
        if src in self.files:
            self._make_parents(dst)
            self.files[dst] = self.files.pop(src)
            return web.json_response({"status": "ok"})
        if src not in self.dirs:
            return _missing()
        if not self._is_dir(_parent(dst)):
            return _missing()
        if dst in self.dirs and self._under(dst):
            return _missing(409, "path already exists")
        moved = self._under(src)
        for child in moved:
            new = dst + child[len(src) :]
            if child in self.files:
                self.files[new] = self.files.pop(child)
            else:
                self.dirs.discard(child)
                self.dirs.add(new)
        self.dirs.discard(src)
        self.dirs.add(dst)
        return web.json_response({"status": "ok"})

    async def batch_stat(self, request: web.Request) -> web.Response:
        self.requests.append(("POST", "/v1/fs:batch-stat"))
        if not self._authorized(request):
            return _missing(401, "unauthorized")
        body = await request.json()
        results = []
        for asked in body["paths"]:
            path = asked.rstrip("/") or "/"
            entry = self._entry(path, prefer_dir=asked.endswith("/"))
            if entry is None or (asked.endswith("/") and not entry["isDir"]):
                results.append(
                    {"path": path, "status": 404, "error": "not found"}
                )
                continue
            results.append(
                {"path": path, "status": 200, "mtime": MTIME, **entry}
            )
        return web.json_response({"results": results})

    async def initiate(self, request: web.Request) -> web.Response:
        self.requests.append(("POST", "/v2/uploads/initiate"))
        if not self._authorized(request):
            return _missing(401, "unauthorized")
        body = await request.json()
        upload_id = f"up{len(self.uploads) + 1}"
        total = body["total_size"]
        parts = -(-total // self.part_size)
        self.uploads[upload_id] = Upload(body["path"], total)
        return web.json_response(
            {
                "upload_id": upload_id,
                "part_size": self.part_size,
                "total_parts": parts,
            },
            status=202,
        )

    async def upload_action(self, request: web.Request) -> web.Response:
        upload_id = request.match_info["id"]
        action = request.match_info["action"]
        self.requests.append(("POST", f"/v2/uploads/{action}"))
        if not self._authorized(request):
            return _missing(401, "unauthorized")
        upload = self.uploads.get(upload_id)
        if upload is None:
            return _missing(404, "upload not found")
        total = upload.total
        if action == "presign-batch":
            body = await request.json()
            parts = []
            for entry in body["parts"]:
                number = entry["part_number"]
                start = (number - 1) * self.part_size
                parts.append(
                    {
                        "number": number,
                        "url": f"{self.object_url}/s3/upload/{upload_id}/"
                        f"{number}",
                        "size": min(self.part_size, total - start),
                    }
                )
            return web.json_response({"parts": parts})
        if action == "complete":
            body = await request.json()
            if len(body["parts"]) != -(-total // self.part_size):
                return _missing(400, "part count mismatch")
            for part in body["parts"]:
                if part["etag"] != f'"etag-{part["number"]}"':
                    return _missing(400, "etag mismatch")
            return self._complete(upload_id)
        if action == "abort":
            del self.uploads[upload_id]
            return web.json_response({"status": "aborted"})
        return _missing(404)

    def _complete(self, upload_id: str) -> web.Response:
        upload = self.uploads.pop(upload_id)
        data = b"".join(upload.parts[n] for n in sorted(upload.parts))
        if len(data) != upload.total:
            return _missing(400, "part sizes do not match the upload")
        self._make_parents(upload.path)
        self.files[upload.path] = data
        return web.json_response({"status": "ok"})

    async def v1_upload(self, request: web.Request) -> web.Response:
        upload_id = request.match_info["id"]
        action = request.match_info.get("action", "")
        self.requests.append((request.method, f"/v1/uploads/{action}"))
        if not self._authorized(request):
            return _missing(401, "unauthorized")
        if upload_id not in self.uploads:
            return _missing(404, "upload not found")
        if request.method == "DELETE":
            del self.uploads[upload_id]
            return web.json_response({"status": "aborted"})
        return self._complete(upload_id)

    async def object_part(self, request: web.Request) -> web.Response:
        self.requests.append(("PUT", "/s3/upload"))
        if "Authorization" in request.headers:
            self.leaked.append(request.path)
            return web.Response(status=400, text="two credentials")
        if self.fail_parts:
            return web.Response(status=500, text="part refused")
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(self.part_delay)
            body = await request.read()
        finally:
            self.in_flight -= 1
        upload = self.uploads.get(request.match_info["id"])
        if upload is None:
            return web.Response(status=404, text="upload aborted")
        number = int(request.match_info["number"])
        upload.parts[number] = body
        return web.Response(headers={"ETag": f'"etag-{number}"'})

    async def object_read(self, request: web.Request) -> web.Response:
        self.requests.append(("GET", "/s3/objects"))
        if "Authorization" in request.headers:
            self.leaked.append(request.path)
            return web.Response(status=400, text="two credentials")
        data = self.files["/" + request.match_info["path"]]
        ranged = re.fullmatch(
            r"bytes=(\d+)-(\d*)", request.headers.get("Range", "")
        )
        if ranged is None:
            return web.Response(body=data)
        start = int(ranged.group(1))
        end = int(ranged.group(2)) if ranged.group(2) else len(data) - 1
        return web.Response(
            status=206,
            body=data[start : end + 1],
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(data)}",
            },
        )


def _app(fake: FakeDrive9) -> web.Application:
    app = web.Application()
    app.router.add_post("/v1/fs:batch-stat", fake.batch_stat)
    app.router.add_route("*", "/v1/fs/{path:.*}", fake.fs)
    app.router.add_post("/v2/uploads/initiate", fake.initiate)
    app.router.add_post("/v2/uploads/{id}/{action}", fake.upload_action)
    app.router.add_post("/v1/uploads/{id}/{action}", fake.v1_upload)
    app.router.add_delete("/v1/uploads/{id}", fake.v1_upload)
    app.router.add_put("/s3/upload/{id}/{number}", fake.object_part)
    app.router.add_get("/s3/objects/{path:.*}", fake.object_read)
    return app


@contextmanager
def serve(fake: FakeDrive9 | None = None) -> Iterator[FakeDrive9]:
    """Run ``fake`` on its own thread and loop, and yield it with ``url``
    and ``object_url`` set.

    Args:
        fake (FakeDrive9 | None): the file system to serve; empty if None.
    """
    fake = fake or FakeDrive9()
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(_app(fake))

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        fake.url = f"http://127.0.0.1:{port}"
        fake.object_url = f"http://localhost:{port}"

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait()
    try:
        yield fake
    finally:
        asyncio.run_coroutine_threadsafe(runner.cleanup(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
