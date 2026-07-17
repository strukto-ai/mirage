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
from datetime import datetime, timedelta, timezone

from aiohttp import web

import mirage.core.onedrive._client as onedrive_client
import mirage.core.sharepoint._client as sharepoint_client
import mirage.core.sharepoint._resolver as sharepoint_resolver

# Anchored at run time, mirroring moto (the s3 fake) and real Graph, which
# stamp lastModifiedDateTime at write time. A fixed past date would make the
# shared find_mtime case (-mtime -1) exclude every just-written item.
BASE_TIME = datetime.now(timezone.utc).replace(microsecond=0)
MODIFIED = BASE_TIME.strftime("%Y-%m-%dT%H:%M:%SZ")
SITE_ID = "site-main"
SITE_NAME = "Main"
# SharePoint (and OneDrive for Business, which is SharePoint underneath)
# rewrites Office documents server-side after an upload: metadata is
# injected into the file, so downloaded bytes differ from uploaded bytes
# and cTag changes without a user write. The real rewrite is an async
# zip-internal edit; the fake models it as a synchronous, idempotent
# marker append so shared-case expectations stay deterministic.
OFFICE_EXTENSIONS = (".pptx", ".docx", ".xlsx")
ENRICH_MARKER = b"<odsp-metadata/>"


def freeze_clock(base: datetime) -> None:
    # Pin the stamp for suites that print raw mtimes (integ/onedrive.py's
    # `ls -l` cases), mirroring integ/s3.py's moto freeze.
    global BASE_TIME, MODIFIED
    BASE_TIME = base
    MODIFIED = base.strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm(path: str) -> str:
    return path.strip("/")


def _parse_range(header: str | None, size: int) -> tuple[int, int]:
    # Single-range requests only; real Graph also serves single ranges
    # but returns 416 for unsatisfiable ones, which the fake clamps
    # instead (no client path requests past EOF).
    if not header or not header.startswith("bytes="):
        return 0, size
    spec = header[len("bytes="):]
    start_s, _, end_s = spec.partition("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) + 1 if end_s else size
    return start, min(end, size)


class FakeGraph:

    def __init__(self, key: str = "default") -> None:
        self.key = key
        self.files: dict[str, dict] = {}
        self.dirs: set[str] = {""}
        self.base = ""
        self._seq = 0

    def _tag(self) -> str:
        self._seq += 1
        return f"{self.key}-tag{self._seq}"

    def _ensure_parents(self, path: str) -> None:
        parent = posixpath.dirname(path)
        while parent:
            self.dirs.add(parent)
            parent = posixpath.dirname(parent)

    def _write_file(self,
                    path: str,
                    content: bytes,
                    enrich: bool = False) -> dict:
        path = _norm(path)
        # Real Graph auto-creates missing parent folders for some
        # path-addressed uploads and 404s for others (shared/remote
        # folders); the fake always creates them (unpinned edge case).
        self._ensure_parents(path)
        if (enrich and path.lower().endswith(OFFICE_EXTENSIONS)
                and not content.endswith(ENRICH_MARKER)):
            # Only uploads enrich; server-side copies of an already
            # enriched file do not (mirrors real SharePoint, whose
            # metadata rewrite is idempotent rather than accumulative).
            content = content + ENRICH_MARKER
        prior = self.files.get(path)
        versions = prior["versions"] if prior else []
        ctag = self._tag()
        # Version ids follow real Graph numbering ("1.0", "2.0", ...).
        vid = f"{len(versions) + 1}.0"
        # Version timestamps are distinct (real Graph never ties them);
        # a shared constant would make "current version" detection
        # order-dependent and mask stale-version bugs.
        stamp = (BASE_TIME +
                 timedelta(seconds=self._seq)).strftime("%Y-%m-%dT%H:%M:%SZ")
        versions = versions + [{
            "id": vid,
            "lastModifiedDateTime": stamp,
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
            f"{self.base}/download/{self.key}/{path}",
            "versions": [{
                "id": v["id"],
                "lastModifiedDateTime": v["lastModifiedDateTime"],
            } for v in reversed(entry["versions"])],
        }

    def _folder_size(self, path: str) -> int:
        path = _norm(path)
        prefix = path + "/" if path else ""
        return sum(
            len(entry["content"]) for f, entry in self.files.items()
            if not path or f == path or f.startswith(prefix))

    def _folder_item(self, path: str) -> dict:
        return {
            "id": f"{self.key}:folder:{path}" if path else f"{self.key}:root",
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


def _name_exists() -> web.Response:
    return web.json_response(
        {
            "error": {
                "code": "nameAlreadyExists",
                "message": "Name already exists"
            }
        },
        status=409)


def _conflict_behavior(request: web.Request) -> str:
    # Real Graph defaults to "fail" for copy, move and folder creation;
    # the permissive blind-overwrite fake masked real client bugs.
    return request.query.get("@microsoft.graph.conflictBehavior", "fail")


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


def _ref_drive(ref_path: str) -> str | None:
    if "/drives/" not in ref_path:
        return None
    return ref_path.split("/drives/", 1)[1].split("/", 1)[0]


class GraphServer:
    """One fake Graph tenant: a site with one or more drives.

    The default drive serves the OneDrive path shapes (``/me/drive``,
    ``/sites/{id}/drive``); named drives serve the SharePoint shapes
    (``/drives/{id}`` after ``/sites`` discovery).
    """

    def __init__(self, state: FakeGraph) -> None:
        self.state = state
        self.drives: dict[str, FakeGraph] = {state.key: state}
        self.site_drives: list[str] = [state.key]
        self.uploads: dict[str, dict] = {}
        self.monitors: dict[str, dict] = {}
        self.calls: Counter = Counter()
        self._upload_seq = 0
        self._monitor_seq = 0

    def add_drive(self, key: str) -> FakeGraph:
        g = FakeGraph(key)
        g.base = self.state.base
        self.drives[key] = g
        self.site_drives.append(key)
        return g

    def _drive_for(self, path: str) -> FakeGraph | None:
        if path.startswith("/drives/"):
            key = path.split("/", 3)[2]
            return self.drives.get(key)
        return self.state

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.path
        method = request.method
        if path.startswith("/download/"):
            self.calls["download"] += 1
            drive_key, _, rest = path[len("/download/"):].partition("/")
            g = self.drives.get(drive_key)
            if g is None:
                return _not_found()
            return self._serve_bytes(request, g, rest)
        if path.startswith("/upload/"):
            return await self._upload(request, path[len("/upload/"):])
        if path.startswith("/monitor/"):
            # Monitor URLs are unauthenticated, like real Graph
            # long-running-operation URLs (they live outside /v1.0).
            token = path[len("/monitor/"):]
            return web.json_response(
                self.monitors.get(token, {"status": "completed"}))
        if path == "/sites" and method == "GET":
            return web.json_response({
                "value": [{
                    "id": SITE_ID,
                    "name": SITE_NAME,
                    "displayName": SITE_NAME,
                }]
            })
        if path == f"/sites/{SITE_ID}/drives" and method == "GET":
            return web.json_response({
                "value": [{
                    "id": key,
                    "name": key,
                } for key in self.site_drives]
            })
        g = self._drive_for(path)
        if g is None:
            return _not_found()
        item_path, action = _parse_item_path(path)
        if method == "GET":
            kind = action if action in ("children", "content") else "item"
            self.calls[kind] += 1
        return await self._drive(request, g, method, item_path, action)

    async def _drive(self, request: web.Request, g: FakeGraph, method: str,
                     item_path: str, action: str) -> web.StreamResponse:
        if action == "children":
            if method == "POST":
                return await self._mkdir(request, g, item_path)
            return self._children_response(g, item_path)
        if action == "content":
            if method == "PUT":
                data = await request.read()
                return web.json_response(
                    g._write_file(item_path, data, enrich=True))
            return self._serve_bytes(request, g, item_path)
        if action == "createUploadSession":
            return await self._create_upload(request, g, item_path)
        if action == "copy":
            return await self._copy(request, g, item_path)
        if action.startswith("versions/") and action.endswith("/content"):
            vid = action[len("versions/"):-len("/content")]
            return self._version_content(request, g, item_path, vid)
        if action.endswith("/restoreVersion"):
            return web.Response(status=204)
        if action == "versions":
            return self._versions_response(g, item_path)
        if method == "DELETE":
            if not item_path:
                return web.json_response(
                    {
                        "error": {
                            "code": "invalidRequest",
                            "message": "Cannot delete root"
                        }
                    },
                    status=400)
            return web.Response(
                status=204) if g._delete(item_path) else _not_found()
        if method == "PATCH":
            return await self._patch(request, g, item_path)
        item = g._item(item_path)
        return web.json_response(item) if item is not None else _not_found()

    def _children_response(self, g: FakeGraph, item_path: str) -> web.Response:
        if item_path and item_path not in g.dirs:
            return _not_found()
        value = [
            g._item(posixpath.join(item_path, name))
            for name in g._children(item_path)
        ]
        return web.json_response({"value": value})

    def _serve_bytes(self, request: web.Request, g: FakeGraph,
                     path: str) -> web.Response:
        entry = g.files.get(_norm(path))
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

    def _versions_response(self, g: FakeGraph, item_path: str) -> web.Response:
        entry = g.files.get(_norm(item_path))
        if entry is None:
            return _not_found()
        # Real Graph lists versions newest-first.
        value = [{
            "id": v["id"],
            "lastModifiedDateTime": v["lastModifiedDateTime"],
        } for v in reversed(entry["versions"])]
        return web.json_response({"value": value})

    def _version_content(self, request: web.Request, g: FakeGraph,
                         item_path: str, vid: str) -> web.Response:
        entry = g.files.get(_norm(item_path))
        if entry is None:
            return _not_found()
        for v in entry["versions"]:
            if v["id"] == vid:
                return self._range_body(request, v["content"])
        return _not_found()

    async def _mkdir(self, request: web.Request, g: FakeGraph,
                     parent: str) -> web.Response:
        parent = _norm(parent)
        if parent and parent not in g.dirs:
            return _not_found()
        body = await request.json()
        name = body.get("name", "")
        behavior = body.get("@microsoft.graph.conflictBehavior", "fail")
        target = _norm(posixpath.join(parent, name))
        if target in g.dirs or target in g.files:
            if behavior == "replace" and target in g.dirs:
                # Real Graph returns the existing folder; children survive.
                return web.json_response(g._folder_item(target))
            if behavior == "rename":
                # Real Graph inserts the counter before a file extension
                # ("doc 1.pptx"); only folders are renamed here, where
                # the plain " N" suffix matches.
                n = 1
                while (_norm(posixpath.join(parent, f"{name} {n}")) in g.dirs
                       or _norm(posixpath.join(parent,
                                               f"{name} {n}")) in g.files):
                    n += 1
                target = _norm(posixpath.join(parent, f"{name} {n}"))
            else:
                return _name_exists()
        g._ensure_parents(target)
        g.dirs.add(target)
        return web.json_response(g._folder_item(target))

    async def _patch(self, request: web.Request, g: FakeGraph,
                     item_path: str) -> web.Response:
        item_path = _norm(item_path)
        if item_path not in g.files and item_path not in g.dirs:
            return _not_found()
        body = await request.json()
        name = body.get("name") or posixpath.basename(item_path)
        ref = body.get("parentReference", {})
        if "path" in ref:
            parent = _ref_parent(ref["path"])
        else:
            parent = posixpath.dirname(item_path)
        dest = _norm(posixpath.join(parent, name))
        if dest != item_path:
            behavior = _conflict_behavior(request)
            conflict = dest in g.files or dest in g.dirs
            replaceable = (behavior == "replace" and item_path in g.files
                           and dest in g.files)
            if conflict and not replaceable:
                return _name_exists()
            if conflict:
                del g.files[dest]
        if item_path in g.files:
            entry = g.files.pop(item_path)
            # A metadata change bumps eTag; cTag only moves with content.
            entry["etag"] = g._tag()
            g._ensure_parents(dest)
            g.files[dest] = entry
            return web.json_response(g._file_item(dest))
        self._move_dir(g, item_path, dest)
        return web.json_response(g._folder_item(dest))

    def _move_dir(self, g: FakeGraph, src: str, dest: str) -> None:
        g.dirs.discard(src)
        g.dirs.add(dest)
        g._ensure_parents(dest)
        for f in list(g.files):
            if f == src or f.startswith(src + "/"):
                entry = g.files.pop(f)
                g.files[dest + f[len(src):]] = entry
        for d in list(g.dirs):
            if d != src and d.startswith(src + "/"):
                g.dirs.discard(d)
                g.dirs.add(dest + d[len(src):])

    async def _copy(self, request: web.Request, g: FakeGraph,
                    item_path: str) -> web.Response:
        item_path = _norm(item_path)
        if item_path not in g.files and item_path not in g.dirs:
            return _not_found()
        body = await request.json()
        name = body.get("name") or posixpath.basename(item_path)
        ref = body.get("parentReference", {})
        dest_key = ref.get("driveId") or _ref_drive(ref.get("path", ""))
        dest_g = self.drives.get(dest_key, g) if dest_key else g
        parent = _ref_parent(ref.get("path", ""))
        dest = _norm(posixpath.join(parent, name))
        # conflictBehavior on copy models OneDrive for Business /
        # SharePoint; real consumer OneDrive rejects the parameter (the
        # client never sends it and resolves conflicts itself).
        behavior = _conflict_behavior(request)
        is_file = item_path in g.files
        conflict = dest in dest_g.files or dest in dest_g.dirs
        # replace only applies to file-onto-file; folder conflicts always
        # fail (reported through the monitor, like real Graph).
        replaceable = (behavior == "replace" and is_file
                       and dest in dest_g.files)
        if conflict and not replaceable:
            return self._accept_monitor({
                "status": "failed",
                "error": {
                    "code": "nameAlreadyExists",
                    "message": "Name already exists"
                },
            })
        if is_file:
            dest_g._write_file(dest, g.files[item_path]["content"])
        else:
            self._copy_dir(g, dest_g, item_path, dest)
        return self._accept_monitor({"status": "completed"})

    def _accept_monitor(self, payload: dict) -> web.Response:
        self._monitor_seq += 1
        token = f"op{self._monitor_seq}"
        self.monitors[token] = payload
        resp = web.Response(status=202)
        resp.headers["Location"] = f"{self.state.base}/monitor/{token}"
        return resp

    def _copy_dir(self, g: FakeGraph, dest_g: FakeGraph, src: str,
                  dest: str) -> None:
        dest_g.dirs.add(dest)
        dest_g._ensure_parents(dest)
        for f in list(g.files):
            if f == src or f.startswith(src + "/"):
                dest_g._write_file(dest + f[len(src):], g.files[f]["content"])
        for d in list(g.dirs):
            if d != src and d.startswith(src + "/"):
                dest_g.dirs.add(dest + d[len(src):])

    async def _create_upload(self, request: web.Request, g: FakeGraph,
                             item_path: str) -> web.Response:
        body: dict = {}
        if request.can_read_body:
            try:
                body = await request.json()
            except ValueError:
                body = {}
        item = body.get("item") or {}
        behavior = item.get("@microsoft.graph.conflictBehavior", "fail")
        self._upload_seq += 1
        # The token must be fragment- and path-safe: a "#" would be
        # stripped by the HTTP client as a URL fragment.
        token = f"u{self._upload_seq}"
        self.uploads[token] = {
            "drive": g,
            "path": _norm(item_path),
            "buffer": bytearray(),
            "behavior": behavior,
        }
        return web.json_response({
            "uploadUrl": f"{self.state.base}/upload/{token}",
            "expirationDateTime": MODIFIED,
        })

    async def _upload(self, request: web.Request, token: str) -> web.Response:
        # Chunks are assumed sequential; real upload sessions also
        # support a status GET, DELETE (cancel), expiration and 416 on
        # overlapping ranges, none of which the client exercises.
        session = self.uploads.get(token)
        if session is None:
            return _not_found()
        chunk = await request.read()
        session["buffer"].extend(chunk)
        content_range = request.headers.get("Content-Range", "")
        total = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range \
            else len(session["buffer"])
        if len(session["buffer"]) >= total:
            g = session["drive"]
            path = session["path"]
            # Sessions default to "fail": the conflict surfaces on the
            # final chunk, exactly like real Graph.
            if path in g.files and session["behavior"] != "replace":
                del self.uploads[token]
                return _name_exists()
            item = g._write_file(path, bytes(session["buffer"]), enrich=True)
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
    sharepoint_client.GRAPH_API = state.base
    sharepoint_resolver.GRAPH_API = state.base
    return state, server, runner
