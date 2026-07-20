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
import hashlib
import json
from datetime import datetime, timezone

from aiohttp import web

# Anchored at run time, mirroring integ/server/onedrive_server.py: real Box
# stamps modified_at at write time, and the shared find_mtime case (-mtime -1)
# needs just-written items to fall inside the window.
BASE_TIME = datetime.now(timezone.utc).replace(microsecond=0)
MODIFIED = BASE_TIME.strftime("%Y-%m-%dT%H:%M:%S+00:00")
ROOT_ID = "0"
LIST_FIELDS = ("id", "name", "type", "size", "modified_at", "etag", "sha1",
               "parent")


def freeze_clock(base: datetime) -> None:
    # Pin the stamp for suites that print raw mtimes (`ls -l` cases),
    # mirroring the s3 moto freeze and the fake Graph.
    global BASE_TIME, MODIFIED
    BASE_TIME = base
    MODIFIED = base.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def _error(status: int, code: str, message: str) -> web.Response:
    # Real Box error envelope: {"type": "error", "status", "code", "message"}.
    return web.json_response(
        {
            "type": "error",
            "status": status,
            "code": code,
            "message": message
        },
        status=status)


def _parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes="):]
    start_s, _, end_s = spec.partition("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) + 1 if end_s else size
    return start, min(end, size)


class FakeBox:
    """In-memory Box content tree keyed by item id, root folder id "0"."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {
            ROOT_ID: {
                "type": "folder",
                "id": ROOT_ID,
                "name": "All Files",
                "parent": None,
                "modified_at": MODIFIED,
            }
        }
        self.base = ""
        self._seq = 1000000000

    def _new_id(self) -> str:
        # Box ids are opaque numeric strings.
        self._seq += 1
        return str(self._seq)

    def children(self, folder_id: str) -> list[dict]:
        kids = [it for it in self.items.values() if it["parent"] == folder_id]
        # Real Box lists folders first, then files, each alphabetically.
        kids.sort(key=lambda it: (it["type"] != "folder", it["name"]))
        return kids

    def child_by_name(self, folder_id: str, name: str) -> dict | None:
        for it in self.children(folder_id):
            if it["name"] == name:
                return it
        return None

    def add_folder(self, parent_id: str, name: str) -> dict:
        item = {
            "type": "folder",
            "id": self._new_id(),
            "name": name,
            "parent": parent_id,
            "modified_at": MODIFIED,
        }
        self.items[item["id"]] = item
        return item

    def add_file(self, parent_id: str, name: str, content: bytes) -> dict:
        item = {
            "type": "file",
            "id": self._new_id(),
            "name": name,
            "parent": parent_id,
            "modified_at": MODIFIED,
            "content": content,
            "sha1": hashlib.sha1(content).hexdigest(),
            "version": 1,
        }
        self.items[item["id"]] = item
        return item

    def update_file(self, item: dict, content: bytes) -> dict:
        item["content"] = content
        item["sha1"] = hashlib.sha1(content).hexdigest()
        item["version"] += 1
        item["modified_at"] = MODIFIED
        return item

    def remove(self, item_id: str) -> None:
        for kid in list(self.children(item_id)):
            self.remove(kid["id"])
        self.items.pop(item_id, None)

    def copy_tree(self, src: dict, parent_id: str, name: str) -> dict:
        if src["type"] == "folder":
            new = self.add_folder(parent_id, name)
            for kid in self.children(src["id"]):
                self.copy_tree(kid, new["id"], kid["name"])
            return new
        return self.add_file(parent_id, name, src["content"])

    def seed_path(self, path: str, content: bytes) -> dict:
        # Creates intermediate folders along a slash path, then the file.
        # Convenience for adapters; the wire equivalents are POST /2.0/folders
        # and the multipart upload below.
        parts = [p for p in path.split("/") if p]
        folder_id = ROOT_ID
        for name in parts[:-1]:
            child = self.child_by_name(folder_id, name)
            if child is None:
                child = self.add_folder(folder_id, name)
            folder_id = child["id"]
        existing = self.child_by_name(folder_id, parts[-1])
        if existing is not None and existing["type"] == "file":
            return self.update_file(existing, content)
        return self.add_file(folder_id, parts[-1], content)

    def ancestors(self, item_id: str) -> list[dict]:
        # Ancestor chain from the account root down to the immediate parent,
        # excluding the item itself (Box's path_collection shape).
        chain: list[dict] = []
        cur = self.items.get(item_id)
        while cur is not None and cur["parent"] is not None:
            parent = self.items.get(cur["parent"])
            if parent is None:
                break
            chain.append(parent)
            cur = parent
        chain.reverse()
        return chain

    def is_descendant(self, item_id: str, folder_id: str) -> bool:
        cur = self.items.get(item_id)
        while cur is not None and cur["parent"] is not None:
            if cur["parent"] == folder_id:
                return True
            cur = self.items.get(cur["parent"])
        return False

    def search_entry(self, item: dict) -> dict:
        chain = self.ancestors(item["id"])
        return {
            "type": item["type"],
            "id": item["id"],
            "name": item["name"],
            "path_collection": {
                "total_count":
                len(chain),
                "entries": [{
                    "type": "folder",
                    "id": a["id"],
                    "name": a["name"]
                } for a in chain],
            },
        }

    def render(self, item: dict) -> dict:
        out = {
            "type": item["type"],
            "id": item["id"],
            "name": item["name"],
            "modified_at": item["modified_at"],
        }
        if item["parent"] is not None:
            out["parent"] = {"type": "folder", "id": item["parent"]}
        else:
            out["parent"] = None
        if item["type"] == "file":
            out["size"] = len(item["content"])
            out["sha1"] = item["sha1"]
            out["etag"] = str(item["version"])
        else:
            out["etag"] = "0"
        return out


class BoxServer:
    """Real-shaped Box API over FakeBox: OAuth token, folder listing with
    offset/limit pagination, file info, 302 content download with Range,
    multipart upload, folder create, and search."""

    def __init__(self, state: FakeBox) -> None:
        self.state = state

    def _authed(self, request: web.Request) -> bool:
        auth = request.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and len(auth) > len("Bearer ")

    async def token(self, request: web.Request) -> web.Response:
        form = await request.post()
        grant = form.get("grant_type", "")
        if grant not in ("client_credentials", "refresh_token"):
            return _error(400, "unsupported_grant_type", f"grant: {grant}")
        body = {"access_token": "integ-box-token", "expires_in": 3600}
        if grant == "refresh_token":
            body["refresh_token"] = "integ-box-refresh"
        return web.json_response(body)

    async def list_items(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        folder = self.state.items.get(request.match_info["folder_id"])
        if folder is None or folder["type"] != "folder":
            return _error(404, "not_found", "folder not found")
        kids = self.state.children(folder["id"])
        offset = int(request.query.get("offset", "0"))
        limit = int(request.query.get("limit", "100"))
        page = kids[offset:offset + limit]
        return web.json_response({
            "total_count":
            len(kids),
            "entries": [self.state.render(it) for it in page],
            "offset":
            offset,
            "limit":
            limit,
        })

    async def create_folder(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        body = await request.json()
        parent_id = body.get("parent", {}).get("id", "")
        name = body.get("name", "")
        parent = self.state.items.get(parent_id)
        if parent is None or parent["type"] != "folder":
            return _error(404, "not_found", "parent folder not found")
        if not name:
            return _error(400, "bad_request", "name is required")
        if self.state.child_by_name(parent_id, name) is not None:
            return _error(409, "item_name_in_use", f"{name} already exists")
        item = self.state.add_folder(parent_id, name)
        return web.json_response(self.state.render(item), status=201)

    async def folder_info(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["folder_id"])
        if item is None or item["type"] != "folder":
            return _error(404, "not_found", "folder not found")
        return web.json_response(self.state.render(item))

    async def file_info(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or item["type"] != "file":
            return _error(404, "not_found", "file not found")
        out = self.state.render(item)
        fields = request.query.get("fields", "")
        if "representations" in fields:
            # Real Box transcodes many formats server-side; the fake only
            # advertises extracted_text when a seed attached one.
            entries = []
            if "extracted_text" in item:
                url = (f"{self.state.base}/rep/{item['id']}/extracted_text"
                       "{+asset_path}")
                entries.append({
                    "representation": "extracted_text",
                    "status": {
                        "state": "success"
                    },
                    "content": {
                        "url_template": url
                    },
                })
            out["representations"] = {"entries": entries}
        return web.json_response(out)

    async def download(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or item["type"] != "file":
            return _error(404, "not_found", "file not found")
        # Real Box 302s to dl.boxcloud.com; clients follow the redirect.
        raise web.HTTPFound(f"{self.state.base}/dl/{item['id']}")

    async def dl(self, request: web.Request) -> web.Response:
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or item["type"] != "file":
            return _error(404, "not_found", "file not found")
        content = item["content"]
        rng = _parse_range(request.headers.get("Range"), len(content))
        if rng is not None:
            start, end = rng
            if start >= len(content):
                return _error(416, "range_not_satisfiable", "past EOF")
            return web.Response(body=content[start:end],
                                status=206,
                                headers={
                                    "Content-Range":
                                    f"bytes {start}-{end - 1}/{len(content)}"
                                })
        return web.Response(body=content)

    async def rep_text(self, request: web.Request) -> web.Response:
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or "extracted_text" not in item:
            return _error(404, "not_found", "representation not found")
        return web.Response(text=item["extracted_text"])

    async def upload(self, request: web.Request) -> web.Response:
        # Real Box hosts uploads on upload.box.com/api/2.0/files/content as
        # multipart with an `attributes` JSON part and a `file` part; the fake
        # serves the same shape from the API host.
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        attributes: dict = {}
        content = b""
        async for part in await request.multipart():
            if part.name == "attributes":
                attributes = json.loads(await part.text())
            elif part.name == "file":
                content = await part.read()
        parent_id = attributes.get("parent", {}).get("id", "")
        name = attributes.get("name", "")
        parent = self.state.items.get(parent_id)
        if parent is None or parent["type"] != "folder":
            return _error(404, "not_found", "parent folder not found")
        if not name:
            return _error(400, "bad_request", "attributes.name is required")
        if self.state.child_by_name(parent_id, name) is not None:
            return _error(409, "item_name_in_use", f"{name} already exists")
        item = self.state.add_file(parent_id, name, content)
        return web.json_response(
            {
                "total_count": 1,
                "entries": [self.state.render(item)]
            },
            status=201)

    async def upload_version(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or item["type"] != "file":
            return _error(404, "not_found", "file not found")
        content = b""
        async for part in await request.multipart():
            if part.name == "file":
                content = await part.read()
        self.state.update_file(item, content)
        return web.json_response({
            "total_count": 1,
            "entries": [self.state.render(item)]
        })

    async def delete_file(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["file_id"])
        if item is None or item["type"] != "file":
            return _error(404, "not_found", "file not found")
        self.state.remove(item["id"])
        return web.Response(status=204)

    async def delete_folder(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info["folder_id"])
        if item is None or item["type"] != "folder":
            return _error(404, "not_found", "folder not found")
        recursive = request.query.get("recursive", "false") == "true"
        if self.state.children(item["id"]) and not recursive:
            return _error(409, "folder_not_empty", "folder is not empty")
        self.state.remove(item["id"])
        return web.Response(status=204)

    async def _move(self, request: web.Request, kind: str,
                    key: str) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info[key])
        if item is None or item["type"] != kind:
            return _error(404, "not_found", f"{kind} not found")
        body = await request.json()
        new_name = body.get("name", item["name"])
        new_parent = body.get("parent", {}).get("id", item["parent"])
        other = self.state.child_by_name(new_parent, new_name)
        if other is not None and other["id"] != item["id"]:
            return _error(409, "item_name_in_use",
                          f"{new_name} already exists")
        item["name"] = new_name
        item["parent"] = new_parent
        item["modified_at"] = MODIFIED
        return web.json_response(self.state.render(item))

    async def update_file(self, request: web.Request) -> web.Response:
        return await self._move(request, "file", "file_id")

    async def update_folder(self, request: web.Request) -> web.Response:
        return await self._move(request, "folder", "folder_id")

    async def _copy(self, request: web.Request, kind: str,
                    key: str) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        item = self.state.items.get(request.match_info[key])
        if item is None or item["type"] != kind:
            return _error(404, "not_found", f"{kind} not found")
        body = await request.json()
        parent_id = body.get("parent", {}).get("id", "")
        name = body.get("name", item["name"])
        if self.state.items.get(parent_id) is None:
            return _error(404, "not_found", "parent folder not found")
        if self.state.child_by_name(parent_id, name) is not None:
            return _error(409, "item_name_in_use", f"{name} already exists")
        new = self.state.copy_tree(item, parent_id, name)
        return web.json_response(self.state.render(new), status=201)

    async def copy_file(self, request: web.Request) -> web.Response:
        return await self._copy(request, "file", "file_id")

    async def copy_folder(self, request: web.Request) -> web.Response:
        return await self._copy(request, "folder", "folder_id")

    async def search(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "unauthorized", "missing bearer token")
        query = request.query.get("query", "").lower()
        wanted = request.query.get("type")
        content_types = request.query.get("content_types", "name,file_content")
        ancestors = request.query.get("ancestor_folder_ids")
        offset = int(request.query.get("offset", "0"))
        limit = int(request.query.get("limit", "100"))
        scope_ids = ({s
                      for s in ancestors.split(",")
                      if s} if ancestors else None)
        match_name = "name" in content_types
        match_content = "file_content" in content_types
        hits = []
        for it in self.state.items.values():
            if it["id"] == ROOT_ID:
                continue
            if wanted is not None and it["type"] != wanted:
                continue
            if scope_ids is not None and not any(
                    self.state.is_descendant(it["id"], sid)
                    for sid in scope_ids):
                continue
            matched = match_name and query in it["name"].lower()
            if not matched and match_content and it["type"] == "file":
                text = it["content"].decode("utf-8", "ignore").lower()
                matched = query in text
            if matched:
                hits.append(it)
        hits.sort(key=lambda it: it["name"])
        total = len(hits)
        page = hits[offset:offset + limit]
        return web.json_response({
            "total_count":
            total,
            "entries": [self.state.search_entry(it) for it in page],
            "offset":
            offset,
            "limit":
            limit,
        })


def build_app(server: BoxServer) -> web.Application:
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.router.add_post("/oauth2/token", server.token)
    app.router.add_get("/2.0/folders/{folder_id}/items", server.list_items)
    app.router.add_get("/2.0/folders/{folder_id}", server.folder_info)
    app.router.add_post("/2.0/folders", server.create_folder)
    app.router.add_get("/2.0/files/{file_id}", server.file_info)
    app.router.add_get("/2.0/files/{file_id}/content", server.download)
    app.router.add_post("/2.0/files/content", server.upload)
    app.router.add_post("/2.0/files/{file_id}/content", server.upload_version)
    app.router.add_post("/2.0/files/{file_id}/copy", server.copy_file)
    app.router.add_post("/2.0/folders/{folder_id}/copy", server.copy_folder)
    app.router.add_put("/2.0/files/{file_id}", server.update_file)
    app.router.add_put("/2.0/folders/{folder_id}", server.update_folder)
    app.router.add_delete("/2.0/files/{file_id}", server.delete_file)
    app.router.add_delete("/2.0/folders/{folder_id}", server.delete_folder)
    app.router.add_get("/2.0/search", server.search)
    app.router.add_get("/dl/{file_id}", server.dl)
    app.router.add_get("/rep/{file_id}/extracted_text", server.rep_text)
    return app


async def start_fake_box() -> tuple[FakeBox, BoxServer, web.AppRunner]:
    state = FakeBox()
    server = BoxServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    return state, server, runner


async def _serve(port: int) -> None:
    state = FakeBox()
    server = BoxServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}"
    print(f"BOX_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
