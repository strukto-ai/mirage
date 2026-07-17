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

import posixpath
from collections import Counter
from datetime import datetime, timezone

from aiohttp import web

import mirage.core.onedrive._client as onedrive_client

MODIFIED = datetime(2026, 3, 31,
                    tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm(path: str) -> str:
    return path.strip("/")


def _parse_range(header: str | None, size: int) -> tuple[int, int]:
    if not header or not header.startswith("bytes="):
        return 0, size
    spec = header[len("bytes="):]
    start_s, _, end_s = spec.partition("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) + 1 if end_s else size
    return start, min(end, size)


class FakeGraph:

    def __init__(self) -> None:
        self.files: dict[str, dict] = {}
        self.dirs: set[str] = {""}
        self.base = ""
        self._seq = 0

    def _tag(self) -> str:
        self._seq += 1
        return f"tag{self._seq}"

    def _ensure_parents(self, path: str) -> None:
        parent = posixpath.dirname(path)
        while parent:
            self.dirs.add(parent)
            parent = posixpath.dirname(parent)

    def _write_file(self, path: str, content: bytes) -> dict:
        path = _norm(path)
        self._ensure_parents(path)
        prior = self.files.get(path)
        versions = prior["versions"] if prior else []
        ctag = self._tag()
        versions = versions + [{
            "id": ctag,
            "lastModifiedDateTime": MODIFIED,
            "content": content,
        }]
        entry = {
            "content": content,
            "ctag": ctag,
            "etag": ctag,
            "modified": MODIFIED,
            "versions": versions,
        }
        self.files[path] = entry
        return self._file_item(path)

    def _children(self, dirpath: str) -> list[str]:
        dirpath = _norm(dirpath)
        names: set[str] = set()
        for f in self.files:
            if posixpath.dirname(f) == dirpath:
                names.add(posixpath.basename(f))
        for d in self.dirs:
            if d and posixpath.dirname(d) == dirpath:
                names.add(posixpath.basename(d))
        return sorted(names)

    def _file_item(self, path: str) -> dict:
        entry = self.files[path]
        return {
            "id":
            entry["ctag"],
            "name":
            posixpath.basename(path),
            "size":
            len(entry["content"]),
            "lastModifiedDateTime":
            entry["modified"],
            "cTag":
            entry["ctag"],
            "eTag":
            entry["etag"],
            "file": {
                "mimeType": "application/octet-stream"
            },
            "@microsoft.graph.downloadUrl":
            f"{self.base}/download/{path}",
            "versions": [{
                "id": v["id"],
                "lastModifiedDateTime": v["lastModifiedDateTime"],
            } for v in entry["versions"]],
        }

    def _folder_size(self, path: str) -> int:
        path = _norm(path)
        prefix = path + "/" if path else ""
        return sum(
            len(entry["content"]) for f, entry in self.files.items()
            if not path or f == path or f.startswith(prefix))

    def _folder_item(self, path: str) -> dict:
        return {
            "id": f"folder:{path}" if path else "root",
            "name": posixpath.basename(path) if path else "root",
            "size": self._folder_size(path),
            "lastModifiedDateTime": MODIFIED,
            "folder": {
                "childCount": len(self._children(path))
            },
        }

    def _item(self, path: str) -> dict | None:
        path = _norm(path)
        if path in self.files:
            return self._file_item(path)
        if path in self.dirs:
            return self._folder_item(path)
        return None

    def _delete(self, path: str) -> bool:
        path = _norm(path)
        if path in self.files:
            del self.files[path]
            return True
        if path in self.dirs:
            self.dirs.discard(path)
            for f in list(self.files):
                if f == path or f.startswith(path + "/"):
                    del self.files[f]
            for d in list(self.dirs):
                if d == path or d.startswith(path + "/"):
                    self.dirs.discard(d)
            return True
        return False


def _not_found() -> web.Response:
    return web.json_response(
        {"error": {
            "code": "itemNotFound",
            "message": "Item not found"
        }},
        status=404)


def _parse_item_path(path: str) -> tuple[str, str]:
    idx = path.find("/root")
    if idx < 0:
        return "", ""
    rest = path[idx + len("/root"):]
    if rest in ("", "/"):
        return "", ""
    if rest == "/children":
        return "", "children"
    rest = rest[1:] if rest.startswith(":") else rest
    item_part, sep, action = rest.partition(":/")
    return _norm(item_part), (action if sep else "")


def _ref_parent(ref_path: str) -> str:
    after = ref_path.split("root", 1)[-1]
    after = after[1:] if after.startswith(":") else after
    return _norm(after)


class GraphServer:

    def __init__(self, state: FakeGraph) -> None:
        self.state = state
        self.uploads: dict[str, dict] = {}
        self.calls: Counter = Counter()
        self._upload_seq = 0

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.path
        method = request.method
        if path.startswith("/download/"):
            self.calls["download"] += 1
            return self._serve_bytes(request, path[len("/download/"):])
        if path.startswith("/upload/"):
            return await self._upload(request, path[len("/upload/"):])
        if path.startswith("/monitor/"):
            return web.json_response({"status": "completed"})
        item_path, action = _parse_item_path(path)
        if method == "GET":
            kind = action if action in ("children", "content") else "item"
            self.calls[kind] += 1
        return await self._drive(request, method, item_path, action)

    async def _drive(self, request: web.Request, method: str, item_path: str,
                     action: str) -> web.StreamResponse:
        state = self.state
        if action == "children":
            if method == "POST":
                return await self._mkdir(request, item_path)
            return self._children_response(item_path)
        if action == "content":
            if method == "PUT":
                data = await request.read()
                return web.json_response(state._write_file(item_path, data))
            return self._content_response(request, item_path)
        if action == "createUploadSession":
            return self._create_upload(item_path)
        if action == "copy":
            return await self._copy(request, item_path)
        if action.startswith("versions/") and action.endswith("/content"):
            vid = action[len("versions/"):-len("/content")]
            return self._version_content(request, item_path, vid)
        if action.endswith("/restoreVersion"):
            return web.Response(status=204)
        if action == "versions":
            return self._versions_response(item_path)
        if method == "DELETE":
            return web.Response(
                status=204) if state._delete(item_path) else _not_found()
        if method == "PATCH":
            return await self._patch(request, item_path)
        item = state._item(item_path)
        return web.json_response(item) if item is not None else _not_found()

    def _children_response(self, item_path: str) -> web.Response:
        state = self.state
        if item_path and item_path not in state.dirs:
            return _not_found()
        value = [
            state._item(posixpath.join(item_path, name))
            for name in state._children(item_path)
        ]
        return web.json_response({"value": value})

    def _content_response(self, request: web.Request,
                          item_path: str) -> web.Response:
        return self._serve_bytes(request, item_path)

    def _serve_bytes(self, request: web.Request, path: str) -> web.Response:
        entry = self.state.files.get(_norm(path))
        if entry is None:
            return _not_found()
        return self._range_body(request, entry["content"])

    def _range_body(self, request: web.Request,
                    content: bytes) -> web.Response:
        header = request.headers.get("Range")
        start, end = _parse_range(header, len(content))
        body = content[start:end]
        if header and header.startswith("bytes=") and start < end:
            return web.Response(status=206,
                                body=body,
                                content_type="application/octet-stream",
                                headers={
                                    "Content-Range":
                                    f"bytes {start}-{end - 1}/{len(content)}"
                                })
        return web.Response(body=body, content_type="application/octet-stream")

    def _versions_response(self, item_path: str) -> web.Response:
        entry = self.state.files.get(_norm(item_path))
        if entry is None:
            return _not_found()
        value = [{
            "id": v["id"],
            "lastModifiedDateTime": v["lastModifiedDateTime"],
        } for v in entry["versions"]]
        return web.json_response({"value": value})

    def _version_content(self, request: web.Request, item_path: str,
                         vid: str) -> web.Response:
        entry = self.state.files.get(_norm(item_path))
        if entry is None:
            return _not_found()
        for v in entry["versions"]:
            if v["id"] == vid:
                return self._range_body(request, v["content"])
        return _not_found()

    async def _mkdir(self, request: web.Request, parent: str) -> web.Response:
        body = await request.json()
        name = body.get("name", "")
        target = _norm(posixpath.join(parent, name))
        self.state._ensure_parents(target)
        self.state.dirs.add(target)
        return web.json_response(self.state._folder_item(target))

    async def _patch(self, request: web.Request,
                     item_path: str) -> web.Response:
        state = self.state
        item_path = _norm(item_path)
        body = await request.json()
        name = body.get("name") or posixpath.basename(item_path)
        ref = body.get("parentReference", {})
        if "path" in ref:
            parent = _ref_parent(ref["path"])
        else:
            parent = posixpath.dirname(item_path)
        dest = _norm(posixpath.join(parent, name))
        if item_path in state.files:
            entry = state.files.pop(item_path)
            state._ensure_parents(dest)
            state.files[dest] = entry
            return web.json_response(state._file_item(dest))
        if item_path in state.dirs:
            self._move_dir(item_path, dest)
            return web.json_response(state._folder_item(dest))
        return _not_found()

    def _move_dir(self, src: str, dest: str) -> None:
        state = self.state
        state.dirs.discard(src)
        state.dirs.add(dest)
        state._ensure_parents(dest)
        for f in list(state.files):
            if f == src or f.startswith(src + "/"):
                entry = state.files.pop(f)
                state.files[dest + f[len(src):]] = entry
        for d in list(state.dirs):
            if d != src and d.startswith(src + "/"):
                state.dirs.discard(d)
                state.dirs.add(dest + d[len(src):])

    async def _copy(self, request: web.Request,
                    item_path: str) -> web.Response:
        state = self.state
        item_path = _norm(item_path)
        body = await request.json()
        name = body.get("name") or posixpath.basename(item_path)
        parent = _ref_parent(body.get("parentReference", {}).get("path", ""))
        dest = _norm(posixpath.join(parent, name))
        if item_path in state.files:
            state._write_file(dest, state.files[item_path]["content"])
        elif item_path in state.dirs:
            self._copy_dir(item_path, dest)
        else:
            return _not_found()
        resp = web.Response(status=202)
        resp.headers["Location"] = f"{state.base}/monitor/{dest}"
        return resp

    def _copy_dir(self, src: str, dest: str) -> None:
        state = self.state
        state.dirs.add(dest)
        state._ensure_parents(dest)
        for f in list(state.files):
            if f == src or f.startswith(src + "/"):
                state._write_file(dest + f[len(src):],
                                  state.files[f]["content"])
        for d in list(state.dirs):
            if d != src and d.startswith(src + "/"):
                state.dirs.add(dest + d[len(src):])

    def _create_upload(self, item_path: str) -> web.Response:
        self._upload_seq += 1
        token = f"{_norm(item_path)}#{self._upload_seq}"
        self.uploads[token] = {"path": _norm(item_path), "buffer": bytearray()}
        return web.json_response({
            "uploadUrl": f"{self.state.base}/upload/{token}",
            "expirationDateTime": MODIFIED,
        })

    async def _upload(self, request: web.Request, token: str) -> web.Response:
        session = self.uploads.get(token)
        if session is None:
            return _not_found()
        chunk = await request.read()
        session["buffer"].extend(chunk)
        content_range = request.headers.get("Content-Range", "")
        total = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range \
            else len(session["buffer"])
        if len(session["buffer"]) >= total:
            item = self.state._write_file(session["path"],
                                          bytes(session["buffer"]))
            del self.uploads[token]
            return web.json_response(item, status=201)
        return web.json_response(
            {"nextExpectedRanges": [f"{len(session['buffer'])}-"]}, status=202)


async def start_fake_graph() -> tuple[FakeGraph, "GraphServer", web.AppRunner]:
    state = FakeGraph()
    server = GraphServer(state)
    # Real Graph accepts simple PUTs up to 4 MiB; aiohttp's default
    # client_max_size (1 MiB) would 413 them before the handler runs.
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.router.add_route("*", "/{tail:.*}", server.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    onedrive_client.GRAPH_API = state.base
    return state, server, runner
