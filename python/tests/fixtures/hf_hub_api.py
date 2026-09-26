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
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from aiohttp import web

# The Hub answers these to a paths-info body it cannot read as JSON, which
# is what an untyped fetch body is (measured against huggingface.co,
# 2026-09-24).
INVALID_PATHS = "✖ Invalid input\n  → at paths"

SEGMENTS = {"models": "", "datasets": "datasets/", "spaces": "spaces/"}

BUCKETS = "buckets"

UPLOADED_AT = "2026-07-15T14:26:59.811Z"

# An `etags` value that makes a bucket's CDN answer send no ETag at all.
NO_ETAG = "<no etag>"


def blob_oid(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def lfs_oid(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def xet_hash(data: bytes) -> str:
    return hashlib.sha256(b"xet:" + data).hexdigest()


def dir_oid(path: str) -> str:
    return hashlib.sha1(b"tree " + path.encode()).hexdigest()


@dataclass
class FakeHub:
    """A Hugging Face Hub on a local port, for tests that need the wire.

    Speaks tree, paths-info and resolve the way the live Hub does: a
    missing subtree is 404 EntryNotFound, a paths-info body that is not
    JSON is 400, and resolve answers a redirect whose first hop carries a
    different ETag from the bytes it leads to. Files are Xet-shaped unless
    ``xet`` is off, so the final ETag is the xet hash rather than the git
    oid, exactly the case that separates checking the whole row from
    checking the oid alone.

    Args:
        repos (dict): ``(api segment, repo id)`` to ``{path: bytes}``.
        xet (bool): serve files Xet-shaped.
        listed (dict): path to the bytes the tree and paths-info describe
            instead of the served ones, to stage a listing behind the
            download; every id in the row describes that older version.
        etags (dict): path to the final ETag resolve serves instead.
        fail (dict): route name to ``(status, error code)`` it answers.
        log (list): ``(route, path)`` for every Hub-facing request.
        posts (list): each paths-info request's content type and body.
        auth (dict): bucket route name to the ``Authorization`` header of
            each request it answered, "" when none was sent.
        statuses (list): ``(route, status)`` of every bucket CDN answer.

    Buckets live under ``repos[("buckets", id)]`` and speak the bucket
    wire, measured against huggingface.co on 2026-09-25: routes carry no
    revision, paths-info matches paths exactly and answers only file rows
    (a directory or a leading-slash path is ``[]``), rows are
    ``{type, path, size, xetHash, uploadedAt}``, the CDN's strong ETag is
    the xet hash whatever ``xet`` says, and a range starting at or past
    EOF is 416 with no ETag. A bucket's ``etags`` override is sent
    verbatim, and ``NO_ETAG`` omits the header.
    """

    repos: dict[tuple[str, str], dict[str,
                                      bytes]] = field(default_factory=dict)
    xet: bool = True
    listed: dict[str, bytes] = field(default_factory=dict)
    etags: dict[str, str] = field(default_factory=dict)
    fail: dict[str, tuple[int, str]] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    posts: list[dict[str, Any]] = field(default_factory=list)
    auth: dict[str, list[str]] = field(default_factory=dict)
    statuses: list[tuple[str, int]] = field(default_factory=list)
    url: str = ""

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def row(self, path: str, data: bytes) -> dict[str, Any]:
        data = self.listed.get(path, data)
        row: dict[str, Any] = {
            "type": "file",
            "oid": blob_oid(data),
            "size": len(data),
            "path": path,
        }
        if self.xet:
            row["lfs"] = {
                "oid": lfs_oid(data),
                "size": len(data),
                "pointerSize": 134
            }
            row["xetHash"] = xet_hash(data)
        return row

    def etag(self, path: str, data: bytes) -> str:
        if path in self.etags:
            return self.etags[path]
        return xet_hash(data) if self.xet else blob_oid(data)

    def _failure(self, route: str) -> web.Response | None:
        if route not in self.fail:
            return None
        status, code = self.fail[route]
        return _error(status, code, f"fake {route} refused")

    def _files(self, request: web.Request) -> dict[str, bytes] | None:
        info = request.match_info
        return self.repos.get((info["seg"], f"{info['ns']}/{info['name']}"))

    async def tree(self, request: web.Request) -> web.Response:
        prefix = request.match_info.get("prefix", "").strip("/")
        self.log.append(("tree", prefix))
        refused = self._failure("tree")
        if refused is not None:
            return refused
        files = self._files(request)
        if files is None:
            return _error(404, "RepoNotFound", "Repository not found")
        under = prefix + "/" if prefix else ""
        rows = [
            self.row(p, d) for p, d in files.items() if p.startswith(under)
        ]
        if prefix and not rows:
            return _error(404, "EntryNotFound",
                          f"{prefix} does not exist on \"main\"")
        dirs = sorted({
            p.rsplit("/", 1)[0]
            for p in files if p.startswith(under) and "/" in p[len(under):]
        })
        rows = [_dir_row(d) for d in dirs] + rows
        return web.json_response(rows)

    async def paths_info(self, request: web.Request) -> web.Response:
        body = await request.read()
        kind = request.headers.get("Content-Type", "")
        self.posts.append({"content_type": kind, "body": body})
        self.log.append(("paths_info", body.decode(errors="replace")))
        refused = self._failure("paths_info")
        if refused is not None:
            return refused
        if "json" not in kind:
            return web.json_response({"error": INVALID_PATHS}, status=400)
        files = self._files(request)
        if files is None:
            return _error(404, "RepoNotFound", "Repository not found")
        rows = []
        for path in json.loads(body).get("paths", []):
            if path in files:
                rows.append(self.row(path, files[path]))
            elif any(p.startswith(path.rstrip("/") + "/") for p in files):
                rows.append(_dir_row(path.rstrip("/")))
        return web.json_response(rows)

    async def resolve(self, request: web.Request) -> web.Response:
        info = request.match_info
        path = info["path"]
        self.log.append(("resolve", path))
        refused = self._failure("resolve")
        if refused is not None:
            return refused
        files = self._files(request)
        if files is None or path not in files:
            return _error(404, "EntryNotFound", f"{path} not found")
        # The first hop names the LFS sha, never the bytes' own ETag, so
        # a client that read the wrong hop reads the wrong token.
        # Only ever a path on this same server, built from a known segment
        # and the quoted names of a repo and file that exist.
        segment = info["seg"] if info["seg"] in SEGMENTS else "models"
        target = "/cdn/" + "/".join(
            quote(part, safe="")
            for part in (segment, info["ns"],
                         info["name"])) + "/" + quote(path)
        raise web.HTTPFound(
            target, headers={"X-Linked-Etag": f'"{lfs_oid(files[path])}"'})

    def _bucket(self, request: web.Request) -> dict[str, bytes] | None:
        info = request.match_info
        return self.repos.get((BUCKETS, f"{info['ns']}/{info['name']}"))

    def _heard(self, route: str, request: web.Request) -> None:
        self.auth.setdefault(route, []).append(
            request.headers.get("Authorization", ""))

    async def bucket_paths_info(self, request: web.Request) -> web.Response:
        body = await request.read()
        kind = request.headers.get("Content-Type", "")
        self.posts.append({"content_type": kind, "body": body})
        self.log.append(("bucket_paths_info", body.decode(errors="replace")))
        self._heard("bucket_paths_info", request)
        refused = self._failure("bucket_paths_info")
        if refused is not None:
            return refused
        if "json" not in kind:
            return web.json_response({"error": INVALID_PATHS}, status=400)
        files = self._bucket(request)
        if files is None:
            return _error(404, "RepoNotFound", "Repository not found")
        rows = [{
            "type": "file",
            "path": path,
            "size": len(files[path]),
            "xetHash": xet_hash(files[path]),
            "uploadedAt": UPLOADED_AT,
        } for path in json.loads(body).get("paths", []) if path in files]
        return web.json_response(rows)

    async def bucket_resolve(self, request: web.Request) -> web.Response:
        info = request.match_info
        path = info["path"]
        self.log.append(("bucket_resolve", path))
        self._heard("bucket_resolve", request)
        refused = self._failure("bucket_resolve")
        if refused is not None:
            return refused
        files = self._bucket(request)
        if files is None or path not in files:
            return _error(404, "EntryNotFound", "File not found")
        # Only ever a path on this same server, built from the quoted names
        # of a bucket and file that exist.
        target = "/cdn/" + "/".join(
            quote(part, safe="")
            for part in (BUCKETS, info["ns"],
                         info["name"])) + "/" + quote(path)
        raise web.HTTPFound(
            target, headers={"X-Linked-Etag": f'"{xet_hash(files[path])}"'})

    def _bucket_cdn(self, request: web.Request, data: bytes) -> web.Response:
        path = request.match_info["path"]
        etag = self.etags.get(path, f'"{xet_hash(data)}"')
        headers = {} if etag == NO_ETAG else {"ETag": etag}
        span = request.headers.get("Range", "")
        if span.startswith("bytes="):
            first, _, last = span[len("bytes="):].partition("-")
            start = int(first)
            if start >= len(data):
                self.statuses.append(("bucket_cdn", 416))
                return web.Response(status=416)
            end = min(int(last) + 1 if last else len(data), len(data))
            self.statuses.append(("bucket_cdn", 206))
            return web.Response(status=206,
                                body=data[start:end],
                                headers=headers)
        self.statuses.append(("bucket_cdn", 200))
        return web.Response(body=data, headers=headers)

    async def cdn(self, request: web.Request) -> web.Response:
        files = self._files(request)
        if request.match_info["seg"] == BUCKETS:
            return self._bucket_cdn(request,
                                    (files or {})[request.match_info["path"]])
        path = request.match_info["path"]
        data = (files or {})[path]
        headers = {"ETag": f'"{self.etag(path, data)}"'}
        span = request.headers.get("Range", "")
        if span.startswith("bytes="):
            first, _, last = span[len("bytes="):].partition("-")
            end = int(last) + 1 if last else len(data)
            return web.Response(status=206,
                                body=data[int(first):end],
                                headers=headers)
        return web.Response(body=data, headers=headers)


def _error(status: int, code: str, message: str) -> web.Response:
    headers = {"X-Error-Message": message}
    if code:
        headers["X-Error-Code"] = code
    return web.json_response({"error": message},
                             status=status,
                             headers=headers)


def _dir_row(path: str) -> dict[str, Any]:
    return {"type": "directory", "oid": dir_oid(path), "size": 0, "path": path}


def _app(hub: FakeHub) -> web.Application:
    app = web.Application()
    repo = "/api/{seg}/{ns}/{name}"
    app.router.add_get(repo + "/tree/{rev}", hub.tree)
    app.router.add_get(repo + "/tree/{rev}/{prefix:.*}", hub.tree)
    app.router.add_post(repo + "/paths-info/{rev}", hub.paths_info)
    app.router.add_get("/cdn/{seg}/{ns}/{name}/{path:.*}", hub.cdn)
    for seg, route in SEGMENTS.items():

        async def resolve(request: web.Request, seg: str = seg):
            request.match_info["seg"] = seg
            return await hub.resolve(request)

        app.router.add_get("/" + route + "{ns}/{name}/resolve/{rev}/{path:.*}",
                           resolve)
    bucket = "/api/buckets/{ns}/{name}"
    app.router.add_post(bucket + "/paths-info", hub.bucket_paths_info)
    app.router.add_get("/buckets/{ns}/{name}/resolve/{path:.*}",
                       hub.bucket_resolve)
    return app


@contextmanager
def serve(hub: FakeHub | None = None) -> Iterator[FakeHub]:
    """Run ``hub`` on its own thread and loop, and yield it with ``url`` set.

    A thread of its own lets a test on ``asyncio.run`` and a test on the
    pytest loop share one fake, the way ThreadedMotoServer does for s3.

    Args:
        hub (FakeHub | None): the Hub to serve; a fresh empty one if None.
    """
    hub = hub or FakeHub()
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(_app(hub))

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        hub.url = f"http://127.0.0.1:{port}"

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait()
    try:
        yield hub
    finally:
        asyncio.run_coroutine_threadsafe(runner.cleanup(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
