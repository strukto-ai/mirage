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
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

BLOCK = 4 * 1024 * 1024
MODIFIED = "2026-01-01T00:00:00Z"


def content_hash(data: bytes) -> str:
    """Dropbox's content_hash: SHA-256 over the 4 MiB block digests.

    Args:
        data (bytes): the file's bytes.
    """
    blocks = [data[i : i + BLOCK] for i in range(0, len(data), BLOCK)]
    joined = b"".join(hashlib.sha256(b).digest() for b in blocks)
    return hashlib.sha256(joined).hexdigest()


def _norm(path: str) -> str:
    return "/" + "/".join(p for p in path.split("/") if p)


@dataclass
class FakeDropbox:
    """Dropbox's RPC and content routes on a local port.

    Serves what a read, a stat and a listing reach: ``/oauth2/token``,
    ``/2/files/list_folder``, ``/2/files/get_metadata`` and
    ``/2/files/download``. A download answers ``Dropbox-API-Result`` with
    the file's metadata on a full read and on a ranged one (206), as the
    real service does. ``/2/files/upload`` stores the body at the
    ``Dropbox-API-Arg`` path and answers the FileMetadata rendered by
    ``_file_entry``, the renderer get_metadata and listings use, so an
    upload reply's content_hash and a later stat's cannot disagree.

    A rewrite keeps ``server_modified``: the real service repeated it
    across same-size writes, so only ``content_hash`` tells them apart.

    Args:
        files (dict[str, bytes]): Dropbox path to bytes.
        log (list[tuple[str, str]]): ``(route, path)`` for every request.
        url (str): the origin ``serve`` sets once it is listening.
        listed (dict[str, str]): a content_hash ``list_folder`` reports for
            a path in place of the true one, as a listing that lags a write
            would; downloads keep naming the true hash.
        restricted (set[str]): paths that exist but answer get_metadata
            and download with a ``path/restricted_content`` 409, the way
            Dropbox refuses content it may not serve.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    url: str = ""
    listed: dict[str, str] = field(default_factory=dict)
    restricted: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.files = {_norm(k): v for k, v in self.files.items()}

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def write(self, path: str, data: bytes) -> None:
        self.files[_norm(path)] = data

    def _folders(self) -> set[str]:
        out = {"/"}
        for key in self.files:
            parts = key.strip("/").split("/")[:-1]
            for i in range(1, len(parts) + 1):
                out.add("/" + "/".join(parts[:i]))
        return out

    def _file_entry(self, path: str) -> dict[str, Any]:
        data = self.files[path]
        return {
            ".tag": "file",
            "name": path.rsplit("/", 1)[-1],
            "path_display": path,
            "path_lower": path.lower(),
            "id": "id:" + path,
            "size": len(data),
            "server_modified": MODIFIED,
            "client_modified": MODIFIED,
            "content_hash": content_hash(data),
        }

    def _folder_entry(self, path: str) -> dict[str, Any]:
        return {
            ".tag": "folder",
            "name": path.rsplit("/", 1)[-1],
            "path_display": path,
            "path_lower": path.lower(),
            "id": "id:" + path,
        }

    def _children(self, path: str) -> list[dict[str, Any]]:
        base = path.rstrip("/") + "/"
        depth = base.count("/")
        folders = [
            self._folder_entry(f)
            for f in sorted(self._folders())
            if f.startswith(base) and f.count("/") == depth
        ]
        files = [
            {**self._file_entry(k), **self._listed_hash(k)}
            for k in sorted(self.files)
            if k.startswith(base) and k.count("/") == depth
        ]
        return folders + files

    def _listed_hash(self, path: str) -> dict[str, str]:
        hash_ = self.listed.get(path)
        return {} if hash_ is None else {"content_hash": hash_}

    def _missing(self) -> web.Response:
        return web.json_response(
            {
                "error_summary": "path/not_found/..",
                "error": {".tag": "path", "path": {".tag": "not_found"}},
            },
            status=409,
        )

    def _refused(self) -> web.Response:
        return web.json_response(
            {
                "error_summary": "path/restricted_content/..",
                "error": {
                    ".tag": "path",
                    "path": {".tag": "restricted_content"},
                },
            },
            status=409,
        )

    async def token(self, _req: web.Request) -> web.Response:
        self.log.append(("token", ""))
        return web.json_response(
            {"access_token": "t", "expires_in": 14400, "token_type": "bearer"}
        )

    async def list_folder(self, req: web.Request) -> web.Response:
        path = _norm((await req.json()).get("path") or "/")
        self.log.append(("list_folder", path))
        if path not in self._folders():
            return self._missing()
        return web.json_response(
            {"entries": self._children(path), "cursor": "c", "has_more": False}
        )

    async def get_metadata(self, req: web.Request) -> web.Response:
        path = _norm((await req.json())["path"])
        self.log.append(("get_metadata", path))
        if path in self.restricted:
            return self._refused()
        if path in self.files:
            return web.json_response(self._file_entry(path))
        if path in self._folders():
            return web.json_response(self._folder_entry(path))
        return self._missing()

    async def upload(self, req: web.Request) -> web.Response:
        path = _norm(json.loads(req.headers["Dropbox-API-Arg"])["path"])
        self.log.append(("upload", path))
        self.files[path] = await req.read()
        return web.json_response(self._file_entry(path))

    async def download(self, req: web.Request) -> web.Response:
        path = _norm(json.loads(req.headers["Dropbox-API-Arg"])["path"])
        self.log.append(("download", path))
        if path in self.restricted:
            return self._refused()
        if path not in self.files:
            return self._missing()
        data = self.files[path]
        result = {"Dropbox-API-Result": json.dumps(self._file_entry(path))}
        match = re.fullmatch(
            r"bytes=(\d+)-(\d*)", req.headers.get("Range", "")
        )
        if match is None:
            return web.Response(body=data, headers=result)
        start = int(match.group(1))
        if start >= len(data):
            return web.Response(
                status=416, headers={"Content-Range": f"bytes */{len(data)}"}
            )
        end = int(match.group(2)) if match.group(2) else len(data) - 1
        end = min(end, len(data) - 1)
        return web.Response(
            status=206,
            body=data[start : end + 1],
            headers={
                **result,
                "Content-Range": f"bytes {start}-{end}/{len(data)}",
            },
        )


@contextmanager
def serve(dropbox: FakeDropbox | None = None) -> Iterator[FakeDropbox]:
    """Run ``dropbox`` on its own thread and loop, with ``url`` set.

    Args:
        dropbox (FakeDropbox | None): the fake to serve; a fresh empty one
            if None.
    """
    dropbox = dropbox or FakeDropbox()
    app = web.Application()
    app.router.add_post("/oauth2/token", dropbox.token)
    app.router.add_post("/2/files/list_folder", dropbox.list_folder)
    app.router.add_post("/2/files/get_metadata", dropbox.get_metadata)
    app.router.add_post("/2/files/download", dropbox.download)
    app.router.add_post("/2/files/upload", dropbox.upload)
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(app)

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        dropbox.url = f"http://127.0.0.1:{port}"

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait()
    try:
        yield dropbox
    finally:
        asyncio.run_coroutine_threadsafe(runner.cleanup(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
