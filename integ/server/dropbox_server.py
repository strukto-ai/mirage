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

import json
import time

from aiohttp import web


def _now_stamp() -> str:
    # Uploads stamp the real clock (find -mtime expects fresh writes to
    # look fresh, like MinIO/moto in the s3 targets).
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class FakeDropbox:
    """One fake Dropbox account with explicit folder objects.

    Serves every endpoint the backend calls — /oauth2/token plus the
    /2/files RPCs (list_folder, get_metadata, download, upload,
    create_folder_v2, delete_v2, move_v2, copy_v2) — on a single
    origin, matching the DropboxConfig ``endpoint`` override. Mirrors
    the TS fake in integ/server/dropbox.ts.
    """

    def __init__(self) -> None:
        self.folders: set[str] = set()
        self.files: dict[str, tuple[bytes, str]] = {}
        self.endpoint = ""

    def _add_ancestors(self, path: str) -> None:
        parts = path.split("/")[1:-1]
        cur = ""
        for part in parts:
            cur += f"/{part}"
            self.folders.add(cur)

    def _entry_for(self, path: str) -> dict | None:
        stored = self.files.get(path)
        if stored is not None:
            return {
                ".tag": "file",
                "id": f"id:{path}",
                "name": path.rsplit("/", 1)[1],
                "path_lower": path.lower(),
                "path_display": path,
                "size": len(stored[0]),
                "server_modified": stored[1],
            }
        if path in self.folders:
            return {
                ".tag": "folder",
                "id": f"id:{path}",
                "name": path.rsplit("/", 1)[1],
                "path_lower": path.lower(),
                "path_display": path,
            }
        return None

    def _list_children(self, path: str) -> list[dict] | None:
        if path and path not in self.folders:
            return None
        out: list[dict] = []
        for folder in self.folders:
            if folder.rsplit("/", 1)[0] == path:
                out.append(self._entry_for(folder))
        for file in self.files:
            if file.rsplit("/", 1)[0] == path:
                out.append(self._entry_for(file))
        return sorted(out, key=lambda e: e["name"])

    def _remove(self, path: str) -> bool:
        # Removes a file, or a folder plus its subtree (delete_v2).
        if self.files.pop(path, None) is not None:
            return True
        if path not in self.folders:
            return False
        prefix = f"{path}/"
        self.folders.discard(path)
        self.folders = {f for f in self.folders if not f.startswith(prefix)}
        self.files = {
            k: v
            for k, v in self.files.items() if not k.startswith(prefix)
        }
        return True

    def _copy_tree(self, from_path: str, to_path: str) -> bool:
        stored = self.files.get(from_path)
        if stored is not None:
            self.files[to_path] = stored
            self._add_ancestors(to_path)
            return True
        if from_path not in self.folders:
            return False
        prefix = f"{from_path}/"
        self.folders.add(to_path)
        self._add_ancestors(to_path)
        for folder in list(self.folders):
            if folder.startswith(prefix):
                self.folders.add(f"{to_path}/{folder[len(prefix):]}")
        for file, data in list(self.files.items()):
            if file.startswith(prefix):
                self.files[f"{to_path}/{file[len(prefix):]}"] = data
        return True

    async def handle_token(self, request: web.Request) -> web.Response:
        return web.json_response({
            "access_token": "integ-token",
            "expires_in": 14400,
        })

    async def handle_list_folder(self, request: web.Request) -> web.Response:
        body = await request.json()
        entries = self._list_children(body.get("path") or "")
        if entries is None:
            return web.json_response({"error_summary": "path/not_found/..."},
                                     status=409)
        return web.json_response({
            "entries": entries,
            "cursor": "cursor-0",
            "has_more": False,
        })

    async def handle_get_metadata(self, request: web.Request) -> web.Response:
        body = await request.json()
        entry = self._entry_for(body.get("path") or "")
        if entry is None:
            return web.json_response({"error_summary": "path/not_found/..."},
                                     status=409)
        return web.json_response(entry)

    async def handle_download(self, request: web.Request) -> web.Response:
        arg = json.loads(request.headers.get("Dropbox-API-Arg", "{}"))
        stored = self.files.get(arg.get("path") or "")
        if stored is None:
            return web.json_response({"error_summary": "path/not_found/..."},
                                     status=409)
        return web.Response(body=stored[0],
                            content_type="application/octet-stream")

    async def handle_upload(self, request: web.Request) -> web.Response:
        arg = json.loads(request.headers.get("Dropbox-API-Arg", "{}"))
        path = arg.get("path") or ""
        if not path:
            return web.json_response({"error_summary": "path/malformed"},
                                     status=400)
        if path in self.folders:
            return web.json_response(
                {"error_summary": "path/conflict/folder/..."}, status=409)
        self.files[path] = (await request.read(), _now_stamp())
        self._add_ancestors(path)
        return web.json_response(self._entry_for(path))

    async def handle_create_folder(self, request: web.Request) -> web.Response:
        body = await request.json()
        path = body.get("path") or ""
        if not path:
            return web.json_response({"error_summary": "path/malformed"},
                                     status=400)
        if self._entry_for(path) is not None:
            return web.json_response(
                {"error_summary": "path/conflict/folder/..."}, status=409)
        self.folders.add(path)
        self._add_ancestors(path)
        return web.json_response({"metadata": self._entry_for(path)})

    async def handle_delete(self, request: web.Request) -> web.Response:
        body = await request.json()
        path = body.get("path") or ""
        if not path:
            return web.json_response({"error_summary": "path/malformed"},
                                     status=400)
        entry = self._entry_for(path)
        if entry is None or not self._remove(path):
            return web.json_response(
                {"error_summary": "path_lookup/not_found/..."}, status=409)
        return web.json_response({"metadata": entry})

    async def _handle_relocate(self, request: web.Request,
                               move: bool) -> web.Response:
        body = await request.json()
        from_path = body.get("from_path") or ""
        to_path = body.get("to_path") or ""
        if not from_path or not to_path:
            return web.json_response({"error_summary": "path/malformed"},
                                     status=400)
        src = self._entry_for(from_path)
        if src is None:
            return web.json_response(
                {"error_summary": "from_lookup/not_found/..."}, status=409)
        dst = self._entry_for(to_path)
        if dst is not None:
            summary = ("to/conflict/folder/..."
                       if dst[".tag"] == "folder" else "to/conflict/file/...")
            return web.json_response({"error_summary": summary}, status=409)
        self._copy_tree(from_path, to_path)
        if move:
            self._remove(from_path)
        return web.json_response({"metadata": self._entry_for(to_path)})

    async def handle_move(self, request: web.Request) -> web.Response:
        return await self._handle_relocate(request, move=True)

    async def handle_copy(self, request: web.Request) -> web.Response:
        return await self._handle_relocate(request, move=False)


async def start_fake_dropbox() -> tuple[FakeDropbox, web.AppRunner]:
    fake = FakeDropbox()
    # The columnar fixture's example.h5 is ~1.02 MiB; aiohttp's default
    # client_max_size (1 MiB) would 413 its upload.
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.router.add_post("/oauth2/token", fake.handle_token)
    app.router.add_post("/2/files/list_folder", fake.handle_list_folder)
    app.router.add_post("/2/files/get_metadata", fake.handle_get_metadata)
    app.router.add_post("/2/files/download", fake.handle_download)
    app.router.add_post("/2/files/upload", fake.handle_upload)
    app.router.add_post("/2/files/create_folder_v2", fake.handle_create_folder)
    app.router.add_post("/2/files/delete_v2", fake.handle_delete)
    app.router.add_post("/2/files/move_v2", fake.handle_move)
    app.router.add_post("/2/files/copy_v2", fake.handle_copy)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert runner.addresses
    fake.endpoint = f"http://127.0.0.1:{runner.addresses[0][1]}"
    return fake, runner
