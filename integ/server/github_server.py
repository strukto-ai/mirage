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
import base64
import hashlib
import re
from pathlib import Path

from aiohttp import web

# Deliberate divergences from api.github.com, mirroring how
# integ/server/dropbox.ts documents its Gmail-search shortcuts:
#
#   - Code search is token-indexed, not substring. Real GitHub tokenises on
#     non-word characters, so `octo` never matches `octocat`. The fake keeps an
#     inverted index for the same reason it matters to us: grep/rg push-down
#     reads a search miss as "no file contains this literal", so a substring
#     fake would hide the false negatives that push-down can hit in
#     production.
#   - Multiple bare terms AND together, which is GitHub's default.
#   - Files at or above SEARCH_SIZE_LIMIT are not indexed, and only the
#     default branch is searchable.
#   - Ranking is not modelled: `score` is a constant and items come back in
#     path order. Nothing in mirage reads either.
TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")
SEARCH_SIZE_LIMIT = 384 * 1024
DEFAULT_BRANCH = "main"


def _blob_sha(data: bytes) -> str:
    # Real git object id so shas look plausible and stay stable across runs.
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def _tree_sha(path: str) -> str:
    return hashlib.sha1(f"tree\0{path}".encode()).hexdigest()


def _error(status: int, message: str) -> web.Response:
    return web.json_response(
        {
            "message": message,
            "documentation_url": "https://docs.github.com/rest",
        },
        status=status)


class FakeRepo:
    """One in-memory repository: a flat path -> bytes map plus its index.

    Args:
        owner (str): repository owner login.
        name (str): repository name.
        default_branch (str): branch reported by the repo endpoint.
    """

    def __init__(self,
                 owner: str,
                 name: str,
                 default_branch: str = DEFAULT_BRANCH) -> None:
        self.owner = owner
        self.name = name
        self.default_branch = default_branch
        self.files: dict[str, bytes] = {}
        self.terms: dict[str, set[str]] = {}
        self.blobs: dict[str, bytes] = {}

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    def seed_path(self, path: str, data: bytes) -> None:
        key = path.strip("/")
        self.files[key] = data
        self.blobs[_blob_sha(data)] = data
        self._index(key, data)

    def _index(self, path: str, data: bytes) -> None:
        for term in self.terms.values():
            term.discard(path)
        if len(data) >= SEARCH_SIZE_LIMIT:
            return
        text = data.decode("utf-8", errors="ignore").lower()
        for token in TOKEN_RE.findall(text):
            self.terms.setdefault(token, set()).add(path)

    def directories(self) -> set[str]:
        dirs: set[str] = set()
        for path in self.files:
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add("/".join(parts[:i]))
        return dirs

    def blob(self, sha: str) -> bytes | None:
        return self.blobs.get(sha)

    def tree_items(self, scope: str = "") -> list[dict[str, object]]:
        """Recursive tree entries, optionally rooted at a subdirectory.

        Args:
            scope (str): directory to root at, or "" for the whole repo.

        Returns:
            list[dict[str, object]]: entries in git's path order, blobs
            carrying a size and trees carrying none.
        """
        prefix = f"{scope}/" if scope else ""
        items: list[dict[str, object]] = []
        for path in sorted(self.directories()):
            if not path.startswith(prefix) or path == scope:
                continue
            items.append({
                "path": path[len(prefix):],
                "mode": "040000",
                "type": "tree",
                "sha": _tree_sha(path),
            })
        for path, data in sorted(self.files.items()):
            if not path.startswith(prefix):
                continue
            items.append({
                "path": path[len(prefix):],
                "mode": "100644",
                "type": "blob",
                "sha": _blob_sha(data),
                "size": len(data),
            })
        items.sort(key=lambda it: str(it["path"]))
        return items

    def search(self, terms: list[str], path_filter: str | None) -> list[str]:
        if not terms:
            return []
        matched: set[str] | None = None
        for term in terms:
            hits = self.terms.get(term, set())
            matched = set(hits) if matched is None else (matched & hits)
            if not matched:
                return []
        found = sorted(matched or set())
        if path_filter:
            scope = path_filter.strip("/")
            found = [
                p for p in found if p == scope or p.startswith(f"{scope}/")
            ]
        return found


class FakeGitHub:
    """Repository store plus the origin the resources should be pointed at."""

    def __init__(self) -> None:
        self.repos: dict[str, FakeRepo] = {}
        self.base = ""

    def repo(self, owner: str, name: str) -> FakeRepo:
        key = f"{owner}/{name}"
        if key not in self.repos:
            self.repos[key] = FakeRepo(owner, name)
        return self.repos[key]


class GitHubServer:
    """The four read-only api.github.com routes the github backend calls.

    Args:
        state (FakeGitHub): the backing repository store.
    """

    def __init__(self, state: FakeGitHub) -> None:
        self.state = state

    def _authed(self, request: web.Request) -> bool:
        return bool(request.headers.get("Authorization"))

    def _lookup(self, request: web.Request) -> FakeRepo | None:
        owner = request.match_info["owner"]
        name = request.match_info["repo"]
        return self.state.repos.get(f"{owner}/{name}")

    async def repo_info(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        return web.json_response({
            "name": repo.name,
            "full_name": repo.full_name,
            "default_branch": repo.default_branch,
            "owner": {
                "login": repo.owner
            },
        })

    async def tree(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        ref = request.match_info["ref"]
        # The backend passes either a ref name (recursive whole-tree fetch) or
        # a tree sha from a previous listing (the truncation fallback path).
        scope = ""
        if ref not in (repo.default_branch, "HEAD"):
            matches = [d for d in repo.directories() if _tree_sha(d) == ref]
            if not matches:
                return _error(404, "Not Found")
            scope = matches[0]
        return web.json_response({
            "sha": _tree_sha(scope),
            "tree": repo.tree_items(scope),
            "truncated": False,
        })

    async def blob(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        sha = request.match_info["sha"]
        data = repo.blob(sha)
        if data is None:
            return _error(404, "Not Found")
        # GitHub wraps base64 payloads at 60 columns; b64decode ignores the
        # newlines, but emitting them keeps the fixture honest.
        encoded = base64.encodebytes(data).decode()
        return web.json_response({
            "sha": sha,
            "size": len(data),
            "content": encoded,
            "encoding": "base64",
        })

    async def search_code(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return _error(401, "Requires authentication")
        query = request.query.get("q", "")
        terms: list[str] = []
        target: str | None = None
        path_filter: str | None = None
        for word in query.split():
            if word.startswith("repo:"):
                target = word[len("repo:"):]
            elif word.startswith("path:"):
                path_filter = word[len("path:"):]
            else:
                terms.extend(TOKEN_RE.findall(word.lower()))
        if target is None:
            return _error(
                422, "Must include at least one user, "
                "organization, or repository")
        repo = self.state.repos.get(target)
        if repo is None:
            return _error(404, "Not Found")
        paths = repo.search(terms, path_filter)
        items = [{
            "name": path.rsplit("/", 1)[-1],
            "path": path,
            "sha": _blob_sha(repo.files[path]),
            "score": 1.0,
            "repository": {
                "name": repo.name,
                "full_name": repo.full_name,
            },
        } for path in paths]
        return web.json_response({
            "total_count": len(items),
            "incomplete_results": False,
            "items": items,
        })


def build_app(server: GitHubServer) -> web.Application:
    app = web.Application()
    app.router.add_get("/repos/{owner}/{repo}", server.repo_info)
    app.router.add_get("/repos/{owner}/{repo}/git/trees/{ref}", server.tree)
    app.router.add_get("/repos/{owner}/{repo}/git/blobs/{sha}", server.blob)
    app.router.add_get("/search/code", server.search_code)
    return app


async def start_fake_github(
) -> tuple[FakeGitHub, GitHubServer, web.AppRunner]:
    state = FakeGitHub()
    server = GitHubServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    return state, server, runner


def seed_from_dir(state: FakeGitHub, full_name: str, source: Path) -> None:
    """Load every file under a fixture directory into one repository.

    Args:
        state (FakeGitHub): the store to seed.
        full_name (str): "owner/name" of the repository to create.
        source (Path): fixture directory to walk.
    """
    owner, _, name = full_name.partition("/")
    repo = state.repo(owner, name)
    for path in sorted(source.rglob("*")):
        if path.is_file():
            repo.seed_path(
                path.relative_to(source).as_posix(), path.read_bytes())


async def _serve(port: int, repos: list[str]) -> None:
    state = FakeGitHub()
    fixtures = Path(__file__).resolve().parents[1] / "fixtures"
    for spec in repos:
        full_name, _, fixture = spec.partition("=")
        seed_from_dir(state, full_name, fixtures / fixture)
    server = GitHubServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}"
    print(f"GITHUB_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help="owner/name=<fixture dir under integ/fixtures>, repeatable")
    args = parser.parse_args()
    asyncio.run(_serve(args.port, args.repo))


if __name__ == "__main__":
    main()
