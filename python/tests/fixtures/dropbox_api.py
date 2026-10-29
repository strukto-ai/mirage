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
import json
import re
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, cast

from aiohttp import web

from mirage.core.dropbox.client import DropboxApiError

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


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


class DropboxFakeError(DropboxApiError):
    """An error raised by FakeDropbox simulating Dropbox API refusals."""

    def __init__(
        self,
        message: str,
        status: int = 409,
        summary: str = "",
        error_tag: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message, status=status, summary=summary)
        self.error_tag = error_tag
        self.headers = headers or {}


@dataclass
class FakeDropbox:
    """Dropbox's RPC and content routes on a local port.

    Serves what a read, a stat and a listing reach: ``/oauth2/token``,
    ``/2/files/list_folder``, ``/2/files/get_metadata`` and
    ``/2/files/download``. A download answers ``Dropbox-API-Result`` with
    the file's metadata on a full read and on a ranged one (206), as the
    real service does, and a download of a folder answers 409
    ``path/not_file``. ``/2/files/upload`` stores the body at the
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
        hooks (dict[str, Callable[[], None]]): one-shot callbacks run when
            the named route (``upload``, ``delete``, ``move``, ``copy``) is
            reached, before it acts: another writer landing between
            mirage's lookup and its request.

    Every content write mints a new ``rev``, as Dropbox does even for the
    same bytes. An upload in ``update`` mode whose rev is not the file's
    answers 409 ``path/conflict/file/``, and ``delete_v2`` with a stale
    ``parent_rev`` answers 409 ``path_write/conflict/file/`` (measured
    2026-10-05 and 2026-10-08).
    """

    files: dict[str, bytes] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    url: str = ""
    listed: dict[str, str] = field(default_factory=dict)
    restricted: set[str] = field(default_factory=set)
    hooks: dict[str, Callable[[], None]] = field(default_factory=dict)
    revs: dict[str, str] = field(default_factory=dict)
    dirs: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._serial = itertools.count(1)
        self.files = {_norm(k): v for k, v in self.files.items()}
        for path in self.files:
            self._mint(path)

    def _mint(self, path: str) -> None:
        self.revs[path] = f"{next(self._serial):09x}"
        parts = path.strip("/").split("/")[:-1]
        for i in range(1, len(parts) + 1):
            self.dirs.add("/" + "/".join(parts[:i]))

    def read(self, path: str) -> bytes | None:
        return self.files.get(_norm(path))

    def delete(self, path: str) -> None:
        """Remove a file, or a folder with everything under it.

        Args:
            path (str): the entry, relative to the account root.
        """
        path = _norm(path)
        for key in [k for k in self.files if _within(k, path)]:
            del self.files[key]
        self.dirs = {d for d in self.dirs if not _within(d, path)}

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def write(self, path: str, data: bytes) -> None:
        self.files[_norm(path)] = data
        self._mint(_norm(path))

    def _folders(self) -> set[str]:
        out = {"/"} | self.dirs
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
            "rev": self.revs[path],
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
            if f != path and f.startswith(base) and f.count("/") == depth
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

    def _error_response(self, exc: DropboxFakeError) -> web.Response:
        status = exc.status if exc.status is not None else 409
        if status == 416:
            return web.Response(status=416, headers=exc.headers)
        body: dict[str, Any] = {"error_summary": exc.summary}
        if exc.error_tag is not None:
            body["error"] = {".tag": "path", "path": {".tag": exc.error_tag}}
        return web.json_response(body, status=status, headers=exc.headers)

    def _missing(self) -> web.Response:
        return self._error_response(
            DropboxFakeError(
                "not found",
                409,
                summary="path/not_found/..",
                error_tag="not_found",
            )
        )

    def _not_file(self) -> web.Response:
        return self._error_response(
            DropboxFakeError(
                "not file",
                409,
                summary="path/not_file/..",
                error_tag="not_file",
            )
        )

    def _refused(self) -> web.Response:
        return self._error_response(
            DropboxFakeError(
                "restricted content",
                409,
                summary="path/restricted_content/..",
                error_tag="restricted_content",
            )
        )

    @staticmethod
    def _conflict(summary: str) -> web.Response:
        return web.json_response({"error_summary": summary}, status=409)

    def _hook(self, route: str) -> None:
        hook = self.hooks.pop(route, None)
        if hook is not None:
            hook()

    def _under(self, path: str) -> list[str]:
        base = path.rstrip("/") + "/"
        return [k for k in self.files if k == path or k.startswith(base)]

    def handle_token(self) -> dict[str, Any]:
        self.log.append(("token", ""))
        return {
            "access_token": "t",
            "expires_in": 14400,
            "token_type": "bearer",
        }

    def handle_list_folder(
        self, body: dict[str, Any] | None = None, *, path: str | None = None
    ) -> dict[str, Any]:
        p = _norm(
            path if path is not None else (body or {}).get("path") or "/"
        )
        self.log.append(("list_folder", p))
        if p not in self._folders():
            raise DropboxFakeError(
                f"not found: {p}",
                409,
                summary="path/not_found/..",
                error_tag="not_found",
            )
        return {
            "entries": self._children(p),
            "cursor": "c",
            "has_more": False,
        }

    def handle_get_metadata(
        self, body: dict[str, Any] | None = None, *, path: str | None = None
    ) -> dict[str, Any]:
        p = _norm(path if path is not None else (body or {}).get("path", ""))
        self.log.append(("get_metadata", p))
        if p in self.restricted:
            raise DropboxFakeError(
                f"restricted: {p}",
                409,
                summary="path/restricted_content/..",
                error_tag="restricted_content",
            )
        if p in self.files:
            return self._file_entry(p)
        if p in self._folders():
            return self._folder_entry(p)
        raise DropboxFakeError(
            f"not found: {p}",
            409,
            summary="path/not_found/..",
            error_tag="not_found",
        )

    def handle_upload(
        self, path: str, data: bytes, mode: Any = "add"
    ) -> dict[str, Any]:
        p = _norm(path)
        self.log.append(("upload", p))
        self._hook("upload")
        if isinstance(mode, dict) and mode.get(".tag") == "update":
            if self.revs.get(p) != mode.get("update") or p not in self.files:
                raise DropboxFakeError(
                    f"conflict: {p}",
                    409,
                    summary="path/conflict/file/..",
                )
        elif isinstance(mode, str) and mode not in ("add", "overwrite"):
            if self.revs.get(p) != mode or p not in self.files:
                raise DropboxFakeError(
                    f"conflict: {p}",
                    409,
                    summary="path/conflict/file/..",
                )
        self.files[p] = data
        self._mint(p)
        return self._file_entry(p)

    def handle_delete_v2(
        self,
        body: dict[str, Any] | None = None,
        *,
        path: str | None = None,
        parent_rev: str | None = None,
    ) -> dict[str, Any]:
        body = body or {}
        p = _norm(path if path is not None else body.get("path", ""))
        self.log.append(("delete", p))
        self._hook("delete")
        if p not in self.files and p not in self._folders():
            raise DropboxFakeError(
                f"not found: {p}", 409, summary="path_lookup/not_found/.."
            )
        want = parent_rev if parent_rev is not None else body.get("parent_rev")
        if want is not None and self.revs.get(p) != want:
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path_write/conflict/file/.."
            )
        if p in self.files:
            entry = self._file_entry(p)
            del self.files[p]
            self.revs.pop(p, None)
        else:
            entry = self._folder_entry(p)
            for key in self._under(p):
                del self.files[key]
                self.revs.pop(key, None)
            self.dirs = {d for d in self.dirs if not _within(d, p)}
        return {"metadata": entry}

    def handle_create_folder_v2(
        self, body: dict[str, Any] | None = None, *, path: str | None = None
    ) -> dict[str, Any]:
        body = body or {}
        p = _norm(path if path is not None else body.get("path", ""))
        self.log.append(("create_folder", p))
        self._hook("create_folder")
        if p in self.files or p in self._folders():
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path/conflict/folder/.."
            )
        parts = p.strip("/").split("/")
        for i in range(1, len(parts) + 1):
            self.dirs.add("/" + "/".join(parts[:i]))
        return {"metadata": self._folder_entry(p)}

    def handle_relocate(
        self,
        body: dict[str, Any] | None = None,
        route: str = "move",
        *,
        from_path: str | None = None,
        to_path: str | None = None,
    ) -> dict[str, Any]:
        body = body or {}
        src = _norm(
            from_path if from_path is not None else body.get("from_path", "")
        )
        dst = _norm(
            to_path if to_path is not None else body.get("to_path", "")
        )
        self.log.append((route, src))
        self._hook(route)
        if src not in self.files and src not in self._folders():
            raise DropboxFakeError(
                f"not found: {src}", 409, summary="from_lookup/not_found/.."
            )
        if dst in self.files:
            raise DropboxFakeError(
                f"conflict: {dst}", 409, summary="to/conflict/file/.."
            )
        if dst in self._folders():
            raise DropboxFakeError(
                f"conflict: {dst}", 409, summary="to/conflict/folder/.."
            )
        moved = {k: dst + k[len(src) :] for k in self._under(src)}
        for old, new in moved.items():
            self.files[new] = self.files[old]
            self._mint(new)
            if route == "move":
                del self.files[old]
                self.revs[new] = self.revs[old]
        for d in [d for d in self.dirs if _within(d, src)]:
            self.dirs.add(dst + d[len(src) :])
            if route == "move":
                self.dirs.discard(d)
        entry = (
            self._file_entry(dst)
            if dst in self.files
            else self._folder_entry(dst)
        )
        return {"metadata": entry}

    def handle_move(
        self,
        body: dict[str, Any] | None = None,
        *,
        from_path: str | None = None,
        to_path: str | None = None,
    ) -> dict[str, Any]:
        return self.handle_relocate(
            body, "move", from_path=from_path, to_path=to_path
        )

    def handle_copy(
        self,
        body: dict[str, Any] | None = None,
        *,
        from_path: str | None = None,
        to_path: str | None = None,
    ) -> dict[str, Any]:
        return self.handle_relocate(
            body, "copy", from_path=from_path, to_path=to_path
        )

    def handle_rpc(
        self, endpoint: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        body = body or {}
        ep = endpoint.removeprefix("/2")
        if ep == "/files/list_folder":
            return self.handle_list_folder(body)
        if ep == "/files/get_metadata":
            return self.handle_get_metadata(body)
        if ep == "/files/delete_v2":
            return self.handle_delete_v2(body)
        if ep == "/files/move_v2":
            return self.handle_move(body)
        if ep == "/files/copy_v2":
            return self.handle_copy(body)
        if ep == "/files/create_folder_v2":
            return self.handle_create_folder_v2(body)
        if ep == "/files/list_folder/get_latest_cursor":
            return {"cursor": "c"}
        if ep == "/files/list_folder/continue":
            return {"entries": [], "cursor": "c", "has_more": False}
        if ep == "/files/search_v2":
            return {"matches": [], "has_more": False}
        if ep == "/users/get_space_usage":
            return {
                "allocation": {".tag": "individual", "allocated": 10**12},
                "used": sum(len(v) for v in self.files.values()),
            }
        raise DropboxFakeError(
            f"unknown endpoint: {endpoint}",
            400,
            summary=f"unknown_endpoint/{ep}",
        )

    def handle_download(
        self,
        path: str,
        range_header: str | None = None,
        window: Any = None,
    ) -> tuple[bytes, dict[str, str], int]:
        p = _norm(path)
        self.log.append(("download", p))
        self._hook("download")
        if p in self.restricted:
            raise DropboxFakeError(
                f"restricted: {p}",
                409,
                summary="path/restricted_content/..",
                error_tag="restricted_content",
            )
        if p in self.dirs:
            raise DropboxFakeError(
                f"not file: {p}",
                409,
                summary="path/not_file/..",
                error_tag="not_file",
            )
        if p not in self.files:
            raise DropboxFakeError(
                f"not found: {p}",
                409,
                summary="path/not_found/..",
                error_tag="not_found",
            )
        data = self.files[p]
        result = {"Dropbox-API-Result": json.dumps(self._file_entry(p))}

        if window is not None:
            start = window.offset
            if start >= len(data):
                raise DropboxFakeError(
                    "Range not satisfiable",
                    status=416,
                    headers={"Content-Range": f"bytes */{len(data)}"},
                )
            end = (
                start + window.size - 1
                if window.size is not None
                else len(data) - 1
            )
            end = min(end, len(data) - 1)
            return (
                data[start : end + 1],
                {
                    **result,
                    "Content-Range": f"bytes {start}-{end}/{len(data)}",
                },
                206,
            )

        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header)
            if match is not None:
                start = int(match.group(1))
                if start >= len(data):
                    raise DropboxFakeError(
                        "Range not satisfiable",
                        status=416,
                        headers={"Content-Range": f"bytes */{len(data)}"},
                    )
                end = int(match.group(2)) if match.group(2) else len(data) - 1
                end = min(end, len(data) - 1)
                return (
                    data[start : end + 1],
                    {
                        **result,
                        "Content-Range": f"bytes {start}-{end}/{len(data)}",
                    },
                    206,
                )

        return data, result, 200

    async def token(self, _req: web.Request) -> web.Response:
        return web.json_response(self.handle_token())

    async def list_folder(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_list_folder(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def get_metadata(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_get_metadata(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def upload(self, req: web.Request) -> web.Response:
        arg = json.loads(req.headers.get("Dropbox-API-Arg", "{}"))
        path = arg.get("path", "")
        mode = arg.get("mode", "add")
        data = await req.read()
        try:
            return web.json_response(self.handle_upload(path, data, mode=mode))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def delete_v2(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_delete_v2(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def move(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_move(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def copy(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_copy(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def create_folder_v2(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            return web.json_response(self.handle_create_folder_v2(body))
        except DropboxFakeError as exc:
            return self._error_response(exc)

    async def download(self, req: web.Request) -> web.Response:
        arg = json.loads(req.headers.get("Dropbox-API-Arg", "{}"))
        path = arg.get("path", "")
        range_header = req.headers.get("Range")
        try:
            data, headers, status = self.handle_download(
                path, range_header=range_header
            )
            return web.Response(body=data, headers=headers, status=status)
        except DropboxFakeError as exc:
            return self._error_response(exc)


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
    app.router.add_post("/2/files/delete_v2", dropbox.delete_v2)
    app.router.add_post("/2/files/move_v2", dropbox.move)
    app.router.add_post("/2/files/copy_v2", dropbox.copy)
    app.router.add_post("/2/files/create_folder_v2", dropbox.create_folder_v2)
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(app)

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = cast(Any, site._server).sockets[0].getsockname()[1]
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
