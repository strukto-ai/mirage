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

import argparse
import asyncio
import json
import posixpath
import time
import urllib.error
import urllib.request
from email.utils import formatdate
from io import BytesIO
from types import SimpleNamespace
from typing import Any
from urllib.parse import quote, urlencode

from aiohttp import web

FILES_ROUTE = "/api/2.0/fs/files/{tail:.*}"
DIRS_ROUTE = "/api/2.0/fs/directories/{tail:.*}"


def _norm(path: str) -> str:
    return posixpath.normpath("/" + path.strip("/"))


def _parent(path: str) -> str:
    return path.rsplit("/", 1)[0] or "/"


class VolumeStore:

    def __init__(self) -> None:
        self.files: dict[str, tuple[bytes, float]] = {}
        self.dirs: set[str] = {"/"}

    def _add_ancestors(self, path: str) -> None:
        current = _parent(path)
        while True:
            self.dirs.add(current)
            if current == "/":
                return
            current = _parent(current)

    def put_file(self, path: str, data: bytes, mtime: float) -> None:
        norm = _norm(path)
        self.dirs.discard(norm)
        self.files[norm] = (data, mtime)
        self._add_ancestors(norm)

    def get_file(self, path: str) -> tuple[bytes, float] | None:
        return self.files.get(_norm(path))

    def delete_file(self, path: str) -> None:
        norm = _norm(path)
        if norm not in self.files:
            raise KeyError(norm)
        del self.files[norm]

    def make_dir(self, path: str) -> None:
        norm = _norm(path)
        self.dirs.add(norm)
        self._add_ancestors(norm)

    def has_dir(self, path: str) -> bool:
        return _norm(path) in self.dirs

    def delete_dir(self, path: str) -> None:
        norm = _norm(path)
        if norm not in self.dirs:
            raise KeyError(norm)
        prefix = norm + "/"
        self.dirs = {
            d
            for d in self.dirs if d != norm and not d.startswith(prefix)
        }
        self.files = {
            f: v
            for f, v in self.files.items() if not f.startswith(prefix)
        }

    def list_dir(self, path: str) -> list[dict[str, Any]]:
        norm = _norm(path)
        if norm not in self.dirs:
            raise KeyError(norm)
        entries: list[dict[str, Any]] = []
        for file_path, (data, mtime) in self.files.items():
            if _parent(file_path) == norm:
                entries.append({
                    "path": file_path,
                    "name": file_path.rsplit("/", 1)[-1],
                    "is_directory": False,
                    "file_size": len(data),
                    "last_modified": int(mtime * 1000),
                })
        for dir_path in self.dirs:
            if dir_path != "/" and _parent(dir_path) == norm:
                entries.append({
                    "path": dir_path,
                    "name": dir_path.rsplit("/", 1)[-1],
                    "is_directory": True,
                    "last_modified": 0,
                })
        return entries


def _not_found(path: str) -> web.Response:
    return web.json_response(
        {
            "error_code": "RESOURCE_DOES_NOT_EXIST",
            "message": f"Path does not exist: {path}",
        },
        status=404,
    )


def _parse_range(value: str, size: int) -> tuple[int, int]:
    spec = value.split("=", 1)[1]
    start_text, _, end_text = spec.partition("-")
    start = int(start_text)
    end = int(end_text) if end_text else size - 1
    if end >= size:
        end = size - 1
    return start, end


async def files_handler(request: web.Request) -> web.StreamResponse:
    store: VolumeStore = request.app["store"]
    remote = "/" + request.match_info["tail"]
    if request.method in ("GET", "HEAD"):
        entry = store.get_file(remote)
        if entry is None:
            return _not_found(remote)
        data, mtime = entry
        headers = {"Last-Modified": formatdate(mtime, usegmt=True)}
        if request.method == "HEAD":
            return web.Response(status=200, body=data, headers=headers)
        range_header = request.headers.get("Range")
        if range_header:
            start, end = _parse_range(range_header, len(data))
            headers["Content-Range"] = f"bytes {start}-{end}/{len(data)}"
            return web.Response(status=206,
                                body=data[start:end + 1],
                                headers=headers)
        return web.Response(status=200, body=data, headers=headers)
    if request.method == "PUT":
        data = await request.read()
        store.put_file(remote, data, time.time())
        return web.json_response({"path": remote})
    if request.method == "DELETE":
        try:
            store.delete_file(remote)
        except KeyError:
            return _not_found(remote)
        return web.json_response({})
    return web.Response(status=405)


async def directories_handler(request: web.Request) -> web.StreamResponse:
    store: VolumeStore = request.app["store"]
    remote = "/" + request.match_info["tail"]
    if request.method == "GET":
        try:
            entries = store.list_dir(remote)
        except KeyError:
            return _not_found(remote)
        return web.json_response({"contents": entries, "next_page_token": ""})
    if request.method == "HEAD":
        if not store.has_dir(remote):
            return _not_found(remote)
        return web.Response(status=200)
    if request.method == "PUT":
        store.make_dir(remote)
        return web.json_response({"path": remote})
    if request.method == "DELETE":
        try:
            store.delete_dir(remote)
        except KeyError:
            return _not_found(remote)
        return web.json_response({})
    return web.Response(status=405)


def build_app(store: VolumeStore) -> web.Application:
    app = web.Application(client_max_size=1024**3)
    app["store"] = store
    app.router.add_route("*", FILES_ROUTE, files_handler)
    app.router.add_route("*", DIRS_ROUTE, directories_handler)
    return app


class DatabricksNotFound(Exception):

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.status_code = 404
        self.error_code = "RESOURCE_DOES_NOT_EXIST"


def _http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> Any:
    request = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        return urllib.request.urlopen(request)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise DatabricksNotFound(url) from exc
        raise


class _HttpFiles:

    def __init__(self, client: "HttpFilesClient") -> None:
        self._client = client

    def upload(self,
               file_path: str,
               contents: Any,
               overwrite: bool = False) -> None:
        query = {"overwrite": "true"} if overwrite else None
        url = self._client.files_url(file_path, query)
        headers = self._client.auth(
            {"Content-Type": "application/octet-stream"})
        _http_request("PUT", url, headers, contents.read()).close()

    def download(self, file_path: str) -> SimpleNamespace:
        url = self._client.files_url(file_path)
        response = _http_request(
            "GET", url,
            self._client.auth({"Accept": "application/octet-stream"}))
        data = response.read()
        response.close()
        return SimpleNamespace(contents=BytesIO(data))

    def get_metadata(self, file_path: str) -> SimpleNamespace:
        url = self._client.files_url(file_path)
        response = _http_request("HEAD", url, self._client.auth())
        length = response.headers.get("Content-Length")
        modified = response.headers.get("Last-Modified")
        response.close()
        return SimpleNamespace(
            content_length=int(length) if length is not None else None,
            last_modified=modified,
            is_directory=False)

    def get_directory_metadata(self, directory_path: str) -> SimpleNamespace:
        url = self._client.dirs_url(directory_path)
        _http_request("HEAD", url, self._client.auth()).close()
        return SimpleNamespace(is_directory=True)

    def create_directory(self, directory_path: str) -> None:
        url = self._client.dirs_url(directory_path)
        _http_request("PUT", url, self._client.auth()).close()

    def delete(self, file_path: str) -> None:
        url = self._client.files_url(file_path)
        _http_request("DELETE", url, self._client.auth()).close()

    def delete_directory(self, directory_path: str) -> None:
        url = self._client.dirs_url(directory_path)
        _http_request("DELETE", url, self._client.auth()).close()

    def list_directory_contents(
        self,
        directory_path: str,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> list[SimpleNamespace]:
        url = self._client.dirs_url(directory_path)
        response = _http_request("GET", url, self._client.auth())
        payload = json.loads(response.read())
        response.close()
        return [
            SimpleNamespace(path=entry["path"],
                            name=entry.get("name"),
                            file_size=entry.get("file_size"),
                            is_directory=entry.get("is_directory", False),
                            last_modified=entry.get("last_modified"))
            for entry in payload.get("contents", [])
        ]


class _HttpApiClient:

    def __init__(self, client: "HttpFilesClient") -> None:
        self._client = client
        self._cfg = SimpleNamespace(workspace_id=None)

    def do(
        self,
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        response_headers: list[str] | None = None,
        raw: bool = False,
    ) -> dict[str, bytes]:
        url = self._client.host + path
        response = _http_request(method, url, self._client.auth(headers))
        data = response.read()
        response.close()
        return {"contents": data}


class HttpFilesClient:

    def __init__(self, host: str, token: str) -> None:
        self.host = host.rstrip("/")
        self.token = token
        self.files = _HttpFiles(self)
        self.api_client = _HttpApiClient(self)

    def auth(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}"}
        if extra:
            headers.update(extra)
        return headers

    def files_url(self,
                  remote_path: str,
                  query: dict[str, str] | None = None) -> str:
        url = f"{self.host}/api/2.0/fs/files{quote(remote_path)}"
        if query:
            url += "?" + urlencode(query)
        return url

    def dirs_url(self,
                 remote_path: str,
                 query: dict[str, str] | None = None) -> str:
        url = f"{self.host}/api/2.0/fs/directories{quote(remote_path)}"
        if query:
            url += "?" + urlencode(query)
        return url


async def start_fake_databricks() -> tuple[VolumeStore, web.AppRunner, str]:
    store = VolumeStore()
    runner = web.AppRunner(build_app(store))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    return store, runner, base


async def _serve(port: int) -> None:
    store = VolumeStore()
    runner = web.AppRunner(build_app(store))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    print(f"DATABRICKS_ENDPOINT=http://127.0.0.1:{port}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
