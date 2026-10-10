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
import re
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from aiohttp import web

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import Evicted, IndexEntry, ListResult, LookupResult
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.constants import CODE_SEARCH_SIZE_LIMIT
from mirage.core.github.tree import refill_snapshot

SYMLINK = "120000"
REGULAR = "100644"
HEX = frozenset("0123456789abcdef")


def _holds_word(data: bytes, word: str) -> bool:
    text = data.decode(errors="replace").lower()
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", text) is not None


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _sha40(segment: str) -> str | None:
    lowered = segment.lower()
    if len(lowered) == 40 and set(lowered) <= HEX:
        return lowered
    return None


@dataclass(frozen=True)
class Snapshot:
    """The files of one commit, as the fake serves them.

    Args:
        files (dict): repo-relative path to bytes.
        symlinks (frozenset): paths among ``files`` that are symlinks.
    """

    files: dict[str, bytes]
    symlinks: frozenset[str]

    def mode(self, path: str) -> str:
        return SYMLINK if path in self.symlinks else REGULAR

    def dirs(self) -> set[str]:
        return {
            "/".join(path.split("/")[:depth])
            for path in self.files
            for depth in range(1, path.count("/") + 1)
        }

    def head(self) -> str:
        rows = sorted(
            f"{path}\0{self.mode(path)}\0{blob_sha(data)}"
            for path, data in self.files.items()
        )
        return hashlib.sha1(b"commit " + "\n".join(rows).encode()).hexdigest()

    def tree_ids(self) -> dict[str, str]:
        children: dict[str, dict[str, tuple[str, str]]] = {"": {}}
        for at in self.dirs():
            children.setdefault(at, {})
        for path, data in self.files.items():
            parent, _, name = path.rpartition("/")
            children[parent][name] = (self.mode(path), blob_sha(data))
        ids: dict[str, str] = {}
        for at in sorted(children, key=lambda d: (-d.count("/"), d == "")):
            body = b"".join(
                f"{mode} {child}".encode() + b"\0" + bytes.fromhex(sha)
                for child, (mode, sha) in sorted(children[at].items())
            )
            ids[at] = hashlib.sha1(b"tree %d\0" % len(body) + body).hexdigest()
            if at:
                parent, _, name = at.rpartition("/")
                children[parent][name] = ("40000", ids[at])
        return ids


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

    A tree asked by ref answers the head commit as its top-level ``sha``,
    as GitHub does (measured 2026-09-30), and ``{ref}:`` answers the root
    tree. Both derive from the files at request time, so a test that edits
    ``files`` directly moves them. A folder's sha is the git tree sha over
    its children, so it moves only when something under it changes. Every
    head and tree the fake answers is remembered with the files it named:
    a head is served as ``{sha}``, ``{sha}:{dir}`` and recursively, in
    either case and answered in lowercase, and a folder sha keeps listing
    what that folder held.

    The ``{ref}:{dir}`` segment is matched as one path segment, so a
    request whose ``/`` inside it went unencoded is not routed and 404s,
    the way the integ fake's router does.

    Code search answers ``q`` the way the REST endpoint reads it: the
    words outside ``repo:`` and ``path:`` must each appear as a whole
    word, in any case, in a file under 384 KB below ``path:``; one page
    of ``per_page`` rows carries the full ``total_count``.

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
        after_recursive (Callable | None): called once a recursive tree
            response is built, so a test can change the repository between
            two fetches of one line.
        hold_recursive (threading.Event | None): a recursive fetch waits
            on it before answering, off the fake's loop, so a test can line
            readers up while other requests are served.
        drop_sha (bool): answer the recursive tree with no top-level
            ``sha``, the shape of a response that names no version.
        after_head (Callable | None): called once the shallow tree of
            ``ref`` is built, so a test can change the repository right
            after a head was answered.
        hold_dir (threading.Event | None): the shallow tree of ``ref``
            waits on it, off the fake's loop, so other requests are served
            meanwhile.
        fail (dict): route name to ``(status, message)`` it answers.
        log (list): ``(route, raw segment)`` for every request.
        history (dict): commit sha to the files it named.
        trees (dict): tree sha to the files and the folder it named.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    symlinks: set[str] = field(default_factory=set)
    ref: str = "main"
    truncated_recursive: bool = False
    truncated_dirs: dict[str, int] = field(default_factory=dict)
    after_recursive: Callable[[], None] | None = None
    hold_recursive: threading.Event | None = None
    drop_sha: bool = False
    after_head: Callable[[], None] | None = None
    hold_dir: threading.Event | None = None
    fail: dict[str, tuple[int, str]] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    blobs: dict[str, bytes] = field(default_factory=dict)
    history: dict[str, Snapshot] = field(default_factory=dict)
    trees: dict[str, tuple[Snapshot, str]] = field(default_factory=dict)
    # Unroutable until serve() sets it, so a config built too early fails
    # rather than reaching api.github.com.
    url: str = "http://127.0.0.1:9"

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def counts(self) -> tuple[int, int, int]:
        return (self.count("dir"), self.count("recursive"), self.count("blob"))

    def snapshot(self) -> Snapshot:
        return Snapshot(dict(self.files), frozenset(self.symlinks))

    def head(self) -> str:
        return self.snapshot().head()

    def _remember(self, snap: Snapshot) -> None:
        self.history.setdefault(snap.head(), snap)
        for at, sha in snap.tree_ids().items():
            self.trees.setdefault(sha, (snap, at))

    def _commit(self, rev: str) -> Snapshot | None:
        if rev == self.ref:
            return self.snapshot()
        sha = _sha40(rev)
        if sha is None:
            return None
        current = self.snapshot()
        if sha == current.head():
            return current
        return self.history.get(sha)

    def _named_tree(self, segment: str) -> tuple[Snapshot, str] | None:
        sha = _sha40(segment)
        if sha is None:
            return None
        current = self.snapshot()
        for at, tree in current.tree_ids().items():
            if tree == sha:
                return current, at
        return self.trees.get(sha)

    def _row(
        self, snap: Snapshot, ids: dict[str, str], path: str, name: str
    ) -> dict[str, Any]:
        if path in snap.files:
            data = snap.files[path]
            sha = blob_sha(data)
            self.blobs[sha] = data
            return {
                "path": name,
                "mode": snap.mode(path),
                "type": "blob",
                "sha": sha,
                "size": len(data),
            }
        return {
            "path": name,
            "mode": "040000",
            "type": "tree",
            "sha": ids[path],
        }

    def _shallow(
        self, snap: Snapshot, ids: dict[str, str], at: str
    ) -> list[dict[str, Any]]:
        prefix = at + "/" if at else ""
        names = sorted(
            {
                path[len(prefix) :].split("/", 1)[0]
                for path in list(snap.files) + list(snap.dirs())
                if path.startswith(prefix) and path != at
            }
        )
        return [self._row(snap, ids, prefix + name, name) for name in names]

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
            return await self._recursive(raw, segment)
        if ":" in segment:
            return self._point(raw, segment)
        if segment == self.ref:
            return await self._head_listing(raw)
        snap = self._commit(segment)
        if snap is not None:
            return self._listing("dir", raw, snap, "", snap.head())
        named = self._named_tree(segment)
        if named is None:
            self.log.append(("sha_dir", raw))
            return web.json_response({"message": "Not Found"}, status=404)
        return self._listing("sha_dir", raw, named[0], named[1], None)

    async def _head_listing(self, raw: str) -> web.Response:
        self.log.append(("dir", raw))
        refused = self._failure("dir")
        if refused is not None:
            return refused
        if self.hold_dir is not None:
            await asyncio.get_running_loop().run_in_executor(
                None, self.hold_dir.wait, 10
            )
        snap = self.snapshot()
        response = self._listing(None, raw, snap, "", snap.head())
        if self.after_head is not None:
            self.after_head()
        return response

    async def _recursive(self, raw: str, segment: str) -> web.Response:
        self.log.append(("recursive", raw))
        refused = self._failure("recursive")
        if refused is not None:
            return refused
        snap = self._commit(segment)
        if snap is None:
            return web.json_response({"message": "Not Found"}, status=404)
        if self.hold_recursive is not None:
            await asyncio.get_running_loop().run_in_executor(
                None, self.hold_recursive.wait, 10
            )
            if segment == self.ref:
                snap = self.snapshot()
        self._remember(snap)
        ids = snap.tree_ids()
        paths = sorted(list(snap.files) + list(snap.dirs()))
        if self.truncated_recursive:
            paths = [p for p in paths if "/" not in p]
        body: dict[str, Any] = {
            "tree": [self._row(snap, ids, p, p) for p in paths],
            "truncated": self.truncated_recursive,
        }
        if not self.drop_sha:
            body["sha"] = snap.head()
        response = web.json_response(body)
        if self.after_recursive is not None:
            self.after_recursive()
        return response

    def _point(self, raw: str, segment: str) -> web.Response:
        ref, _, at = segment.partition(":")
        at = at.strip("/")
        self.log.append(("dir", raw))
        refused = self._failure("dir")
        if refused is not None:
            return refused
        snap = self._commit(ref)
        if snap is None:
            return web.json_response({"message": "Not Found"}, status=404)
        parts = at.split("/") if at else []
        for depth in range(1, len(parts) + 1):
            if "/".join(parts[:depth]) in snap.files:
                return web.json_response(
                    {
                        "message": "Invalid object requested. SHA must identify a "
                        "commit or a tree."
                    },
                    status=422,
                )
        if at and at not in snap.dirs():
            return web.json_response({"message": "Not Found"}, status=404)
        return self._listing(None, raw, snap, at, None)

    def _listing(
        self,
        route: str | None,
        raw: str,
        snap: Snapshot,
        at: str,
        head: str | None,
    ) -> web.Response:
        if route is not None:
            self.log.append((route, raw))
            refused = self._failure(route)
            if refused is not None:
                return refused
        self._remember(snap)
        ids = snap.tree_ids()
        rows = self._shallow(snap, ids, at)
        truncated = False
        if at in self.truncated_dirs:
            rows = rows[: self.truncated_dirs[at]]
            truncated = True
        return web.json_response(
            {
                "sha": head if head is not None else ids[at],
                "tree": rows,
                "truncated": truncated,
            }
        )

    async def search_code(self, request: web.Request) -> web.Response:
        q = request.query.get("q", "")
        self.log.append(("search", q))
        refused = self._failure("search")
        if refused is not None:
            return refused
        terms = q.split()
        repo = next((t[5:] for t in terms if t.startswith("repo:")), "")
        scope = next((t[5:] for t in terms if t.startswith("path:")), "")
        words = [t.lower() for t in terms if ":" not in t]
        hits = [
            path
            for path, data in sorted(self.files.items())
            if len(data) < CODE_SEARCH_SIZE_LIMIT
            and (not scope or path.startswith(scope.rstrip("/") + "/"))
            and all(_holds_word(data, w) for w in words)
        ]
        per_page = int(request.query.get("per_page", "30"))
        items = [
            {
                "path": path,
                "sha": blob_sha(self.files[path]),
                "repository": {"full_name": repo},
            }
            for path in hits[:per_page]
        ]
        return web.json_response(
            {
                "total_count": len(hits),
                "incomplete_results": False,
                "items": items,
            }
        )

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
        return web.json_response(
            {
                "sha": sha,
                "size": len(data),
                "encoding": "base64",
                "content": base64.encodebytes(data).decode(),
            }
        )


def _app(hub: FakeGitHub) -> web.Application:
    app = web.Application()
    repo = "/repos/{owner}/{repo}"
    app.router.add_get(repo, hub.repo)
    app.router.add_get(repo + "/git/trees/{segment:[^/]+}", hub.tree)
    app.router.add_get(repo + "/git/blobs/{sha}", hub.blob)
    app.router.add_get("/search/code", hub.search_code)
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
# retry sees real data; a root child would let ensure_live_snapshot's root
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
        if self.fired or vfs_path != self.parent or self.accessor is None:
            return result
        self.fired = True
        stale = [k for k in result.entries or [] if k != self.key]
        # Another op refills while this lookup holds the stale listing.
        await refill_snapshot(self.accessor, self, "/gh")
        return ListResult(entries=stale, status=result.status)


class _ClearedMidLookup(RAMIndexCacheStore):
    def __init__(self) -> None:
        super().__init__()
        self.fired = False

    async def get(self, vfs_path: str) -> LookupResult:
        if not self.fired:
            self.fired = True
            await self.clear()
        return await super().get(vfs_path)


class _ClearedAndReseeded(RAMIndexCacheStore):
    def __init__(self) -> None:
        super().__init__()
        self.accessor: GitHubAccessor | None = None
        self.fired = False

    async def get(self, vfs_path: str) -> LookupResult:
        if self.fired or self.accessor is None:
            return await super().get(vfs_path)
        self.fired = True
        await self.clear()
        missed = await super().get(vfs_path)
        await refill_snapshot(self.accessor, self, "/gh")
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


_EPOCH = datetime.fromtimestamp(0, timezone.utc)


class _ExpiredOnArrival(RAMIndexCacheStore):
    def __init__(self, live: frozenset[str]) -> None:
        super().__init__()
        self.live = live

    def seed(
        self,
        entries: dict[str, IndexEntry],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        super().seed(entries, children, expires_at, version=version)
        for path in children:
            if path not in self.live:
                self._expiry[path] = _EPOCH

    async def _set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        return await super()._set_dir(
            vfs_path,
            entries,
            expired_at if vfs_path in self.live else _EPOCH,
            partial=partial,
            evict=evict,
            excluded=excluded,
            version=version,
        )


def expired_on_arrival(*live: str) -> RAMIndexCacheStore:
    """An index whose listings are already expired when they land.

    Args:
        live (str): listing keys stored with the expiry their writer asked
            for, so a test can keep the mount root live.
    """
    return _ExpiredOnArrival(frozenset(live))
