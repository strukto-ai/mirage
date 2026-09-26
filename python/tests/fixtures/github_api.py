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
import hashlib
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import ListResult
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.tree import refill_index

SYMLINK = "120000"
REGULAR = "100644"


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def tree_sha(path: str) -> str:
    return hashlib.sha1(b"tree " + path.encode()).hexdigest()


@dataclass
class FakeGitHub:
    """A GitHub repository on a local port, for tests that need the wire.

    Speaks the four calls the github mount makes the way the live API does
    (measured with ``gh api``, X-GitHub-Api-Version 2022-11-28,
    2026-09-25): the recursive tree of a ref, the shallow tree of
    ``{ref}:{dir}`` (404 for a missing directory or ref, 422 when a path
    component is a file, a symlink row carrying the link's own sha and
    length), the shallow tree of a tree sha, and a blob by sha. Shas are
    real git blob shas, so different bytes always name a different blob,
    and a blob once served stays readable after the file changes, as on
    GitHub.

    The ``{ref}:{dir}`` segment is matched as one path segment, so a
    request whose ``/`` inside it went unencoded is not routed and 404s,
    the way the integ fake's router does.

    Truncating a shallow listing (``truncated_dirs``) is defensive, not
    measured: no single directory in the sampled repositories was large
    enough to truncate.

    Args:
        files (dict): repo-relative path to bytes, on ``ref``.
        symlinks (set): paths among ``files`` that are symlinks, whose
            bytes are the link text.
        ref (str): the only branch, and the repository's default.
        truncated_recursive (bool): answer the recursive tree truncated,
            keeping only top-level rows.
        truncated_dirs (dict): directory to how many rows its shallow
            listing keeps before answering ``truncated``.
        fail (dict): route name to ``(status, message)`` it answers.
        log (list): ``(route, raw segment)`` for every request.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    symlinks: set[str] = field(default_factory=set)
    ref: str = "main"
    truncated_recursive: bool = False
    truncated_dirs: dict[str, int] = field(default_factory=dict)
    fail: dict[str, tuple[int, str]] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    blobs: dict[str, bytes] = field(default_factory=dict)
    url: str = ""

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def counts(self) -> tuple[int, int, int]:
        return (self.count("dir"), self.count("recursive"), self.count("blob"))

    def _dirs(self) -> set[str]:
        return {path.rsplit("/", 1)[0]
                for path in self.files if "/" in path} | {
                    "/".join(path.split("/")[:depth])
                    for path in self.files
                    for depth in range(1, path.count("/"))
                }

    def _row(self, path: str, name: str) -> dict[str, Any]:
        if path in self.files:
            data = self.files[path]
            sha = blob_sha(data)
            self.blobs[sha] = data
            return {
                "path": name,
                "mode": SYMLINK if path in self.symlinks else REGULAR,
                "type": "blob",
                "sha": sha,
                "size": len(data),
            }
        return {
            "path": name,
            "mode": "040000",
            "type": "tree",
            "sha": tree_sha(path)
        }

    def _shallow(self, at: str) -> list[dict[str, Any]]:
        prefix = at + "/" if at else ""
        names = sorted({
            path[len(prefix):].split("/", 1)[0]
            for path in list(self.files) + list(self._dirs())
            if path.startswith(prefix) and path != at
        })
        return [self._row(prefix + name, name) for name in names]

    def _failure(self, route: str) -> web.Response | None:
        if route not in self.fail:
            return None
        status, message = self.fail[route]
        return web.json_response({"message": message}, status=status)

    async def repo(self, request: web.Request) -> web.Response:
        self.log.append(("repo", ""))
        refused = self._failure("repo")
        if refused is not None:
            return refused
        return web.json_response({"default_branch": self.ref})

    async def tree(self, request: web.Request) -> web.Response:
        raw = request.raw_path.split("/git/trees/", 1)[1].split("?", 1)[0]
        segment = request.match_info["segment"]
        if request.query.get("recursive") == "1":
            return self._recursive(raw, segment)
        if ":" in segment:
            return self._point(raw, segment)
        if segment == self.ref:
            return self._listing("dir", raw, "")
        at = next((d for d in self._dirs() if tree_sha(d) == segment), None)
        if at is None:
            self.log.append(("sha_dir", raw))
            return web.json_response({"message": "Not Found"}, status=404)
        return self._listing("sha_dir", raw, at)

    def _recursive(self, raw: str, segment: str) -> web.Response:
        self.log.append(("recursive", raw))
        refused = self._failure("recursive")
        if refused is not None:
            return refused
        if segment != self.ref:
            return web.json_response({"message": "Not Found"}, status=404)
        paths = sorted(list(self.files) + list(self._dirs()))
        if self.truncated_recursive:
            paths = [p for p in paths if "/" not in p]
        return web.json_response({
            "sha": tree_sha(""),
            "tree": [self._row(p, p) for p in paths],
            "truncated": self.truncated_recursive,
        })

    def _point(self, raw: str, segment: str) -> web.Response:
        ref, _, at = segment.partition(":")
        at = at.strip("/")
        self.log.append(("dir", raw))
        refused = self._failure("dir")
        if refused is not None:
            return refused
        if ref != self.ref:
            return web.json_response({"message": "Not Found"}, status=404)
        parts = at.split("/") if at else []
        for depth in range(1, len(parts) + 1):
            if "/".join(parts[:depth]) in self.files:
                return web.json_response(
                    {
                        "message":
                        "Invalid object requested. SHA must identify a "
                        "commit or a tree."
                    },
                    status=422)
        if at and at not in self._dirs():
            return web.json_response({"message": "Not Found"}, status=404)
        return self._listing(None, raw, at)

    def _listing(self, route: str | None, raw: str, at: str) -> web.Response:
        if route is not None:
            self.log.append((route, raw))
            refused = self._failure(route)
            if refused is not None:
                return refused
        rows = self._shallow(at)
        truncated = False
        if at in self.truncated_dirs:
            rows = rows[:self.truncated_dirs[at]]
            truncated = True
        return web.json_response({
            "sha": tree_sha(at),
            "tree": rows,
            "truncated": truncated
        })

    async def blob(self, request: web.Request) -> web.Response:
        sha = request.match_info["sha"]
        self.log.append(("blob", sha))
        refused = self._failure("blob")
        if refused is not None:
            return refused
        for data in self.files.values():
            self.blobs.setdefault(blob_sha(data), data)
        if sha not in self.blobs:
            return web.json_response({"message": "Not Found"}, status=404)
        data = self.blobs[sha]
        return web.json_response({
            "sha": sha,
            "size": len(data),
            "encoding": "base64",
            "content": base64.encodebytes(data).decode(),
        })


def _app(hub: FakeGitHub) -> web.Application:
    app = web.Application()
    repo = "/repos/{owner}/{repo}"
    app.router.add_get(repo, hub.repo)
    app.router.add_get(repo + "/git/trees/{segment:[^/]+}", hub.tree)
    app.router.add_get(repo + "/git/blobs/{sha}", hub.blob)
    return app


@contextmanager
def serve(hub: FakeGitHub | None = None) -> Iterator[FakeGitHub]:
    """Run ``hub`` on its own thread and loop, and yield it with ``url`` set.

    Args:
        hub (FakeGitHub | None): the repository to serve; empty if None.
    """
    hub = hub or FakeGitHub()
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


# Each hook fires once, on the first listing of the nested parent, so the
# retry sees real data; a root child would let ensure_live_index's root
# probe consume it instead.
class _ClearedAtList(RAMIndexCacheStore):

    def __init__(self, parent: str) -> None:
        super().__init__()
        self.parent = parent
        self.fired = False

    async def list_dir(self, vfs_path: str) -> ListResult:
        if not self.fired and vfs_path == self.parent:
            self.fired = True
            await self.clear()
        return await super().list_dir(vfs_path)


class _StaleListing(RAMIndexCacheStore):

    def __init__(self, parent: str, key: str) -> None:
        super().__init__()
        self.parent = parent
        self.key = key
        self.accessor: GitHubAccessor | None = None
        self.fired = False

    async def list_dir(self, vfs_path: str) -> ListResult:
        result = await super().list_dir(vfs_path)
        if self.fired or vfs_path != self.parent:
            return result
        self.fired = True
        stale = [k for k in result.entries or [] if k != self.key]
        # Another op refills while this lookup holds the stale listing.
        await refill_index(self.accessor, self, "/gh")
        return ListResult(entries=stale, status=result.status)


class _ClearedMidLookup(RAMIndexCacheStore):

    def __init__(self) -> None:
        super().__init__()
        self.fired = False

    async def get(self, vfs_path: str):
        if not self.fired:
            self.fired = True
            await self.clear()
        return await super().get(vfs_path)


class _ClearedAndReseeded(RAMIndexCacheStore):

    def __init__(self) -> None:
        super().__init__()
        self.accessor: GitHubAccessor | None = None
        self.fired = False

    async def get(self, vfs_path: str):
        if self.fired:
            return await super().get(vfs_path)
        self.fired = True
        await self.clear()
        missed = await super().get(vfs_path)
        await refill_index(self.accessor, self, "/gh")
        return missed


def race_index(kind: str) -> RAMIndexCacheStore:
    """An index that changes under the lookup it serves, once.

    Args:
        kind (str): ``list`` clears at the parent listing, ``stale`` hands
            back a listing without the key while another op refills,
            ``get`` clears at the entry read, ``reseed`` clears and refills
            there so the root reads live.
    """
    if kind == "list":
        return _ClearedAtList("/gh/docs/sub")
    if kind == "stale":
        return _StaleListing("/gh/docs/sub", "/gh/docs/sub/b.txt")
    if kind == "get":
        return _ClearedMidLookup()
    return _ClearedAndReseeded()
