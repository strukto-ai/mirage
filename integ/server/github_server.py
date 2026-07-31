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
import io
import re
import zipfile
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


def _build_artifact_zip() -> bytes:
    # ZIP_STORED with a pinned date_time keeps the archive byte-identical
    # across runs, so size_in_bytes below is a stable contract.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        info = zipfile.ZipInfo("dist/report.txt",
                               date_time=(2026, 5, 3, 0, 0, 0))
        zf.writestr(info, "ci artifact payload\n")
    return buf.getvalue()


# One fixed Actions dataset served for every seeded repository. The list
# payloads and the single-object payloads share the same dicts on purpose:
# the github_ci backend sizes files from list responses and renders reads
# from the GET responses, and GitHub serves the same object shape on both.
CI_ARTIFACT_ZIP = _build_artifact_zip()
CI_JOB_LOG = (b"2026-05-03T00:05:00Z build started\n"
              b"2026-05-03T00:08:00Z build finished\n")
CI_WORKFLOWS = [{
    "id": 101,
    "node_id": "W_101",
    "name": "CI",
    "path": ".github/workflows/ci.yml",
    "state": "active",
    "created_at": "2026-05-01T00:00:00Z",
    "updated_at": "2026-05-02T00:00:00Z",
}]
CI_RUNS = [{
    "id": 9001,
    "name": "CI",
    "run_number": 42,
    "event": "push",
    "status": "completed",
    "conclusion": "success",
    "head_branch": "main",
    "created_at": "2026-05-03T00:00:00Z",
    "updated_at": "2026-05-03T00:10:00Z",
}]
CI_JOBS = {
    "9001": [{
        "id":
        7001,
        "run_id":
        9001,
        "name":
        "build",
        "status":
        "completed",
        "conclusion":
        "success",
        "started_at":
        "2026-05-03T00:05:00Z",
        "completed_at":
        "2026-05-03T00:08:00Z",
        "steps": [{
            "name": "checkout",
            "status": "completed",
            "conclusion": "success",
            "number": 1,
        }],
    }],
}
CI_ARTIFACTS = {
    "9001": [{
        "id": 5001,
        "name": "dist",
        "size_in_bytes": len(CI_ARTIFACT_ZIP),
        "expired": False,
        "created_at": "2026-05-03T00:09:00Z",
        "updated_at": "2026-05-03T00:09:00Z",
    }],
}
CI_ANNOTATIONS = {
    "7001": [{
        "path": "src/app.py",
        "start_line": 3,
        "end_line": 3,
        "annotation_level": "warning",
        "message": "unused import",
    }],
}


def _blob_sha(data: bytes) -> str:
    # Real git object id so shas look plausible and stay stable across runs.
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def _tree_sha(path: str) -> str:
    return hashlib.sha1(f"tree\0{path}".encode()).hexdigest()


def _commit_sha(path: str) -> str:
    return hashlib.sha1(f"commit\0{path}".encode()).hexdigest()


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
        self.submodules: set[str] = set()
        self.truncated = False

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    def seed_path(self, path: str, data: bytes) -> None:
        key = path.strip("/")
        self.files[key] = data
        self.blobs[_blob_sha(data)] = data
        self._index(key, data)

    def seed_submodule(self, path: str) -> None:
        """Register a submodule gitlink: a tree entry of type "commit"
        with a mode of 160000, no size, and no blob behind its sha."""
        self.submodules.add(path.strip("/"))

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
        for path in sorted(self.submodules):
            if not path.startswith(prefix):
                continue
            items.append({
                "path": path[len(prefix):],
                "mode": "160000",
                "type": "commit",
                "sha": _commit_sha(path),
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
            # A per-sha tree GET is one level deep in git; only the
            # ref-name request carries recursive=1.
            items = [
                it for it in repo.tree_items(scope) if "/" not in it["path"]
            ]
            return web.json_response({
                "sha": _tree_sha(scope),
                "tree": items,
                "truncated": False,
            })
        items = repo.tree_items(scope)
        if repo.truncated:
            # A truncated recursive tree keeps only the top-level entries,
            # like git dropping deep paths past its entry cap.
            items = [it for it in items if "/" not in it["path"]]
        return web.json_response({
            "sha": _tree_sha(scope),
            "tree": items,
            "truncated": repo.truncated,
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

    async def _ci_guard(self, request: web.Request) -> web.Response | None:
        if not self._authed(request):
            return _error(401, "Requires authentication")
        if self._lookup(request) is None:
            return _error(404, "Not Found")
        return None

    async def ci_workflows(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        return web.json_response({
            "total_count": len(CI_WORKFLOWS),
            "workflows": CI_WORKFLOWS,
        })

    async def ci_workflow(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        wanted = request.match_info["workflow_id"]
        for wf in CI_WORKFLOWS:
            if str(wf["id"]) == wanted:
                return web.json_response(wf)
        return _error(404, "Not Found")

    async def ci_runs(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        return web.json_response({
            "total_count": len(CI_RUNS),
            "workflow_runs": CI_RUNS,
        })

    async def ci_run(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        wanted = request.match_info["run_id"]
        for run in CI_RUNS:
            if str(run["id"]) == wanted:
                return web.json_response(run)
        return _error(404, "Not Found")

    async def ci_jobs(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        jobs = CI_JOBS.get(request.match_info["run_id"], [])
        return web.json_response({"total_count": len(jobs), "jobs": jobs})

    async def ci_job(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        wanted = request.match_info["job_id"]
        for jobs in CI_JOBS.values():
            for job in jobs:
                if str(job["id"]) == wanted:
                    return web.json_response(job)
        return _error(404, "Not Found")

    async def ci_job_logs(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        return web.Response(body=CI_JOB_LOG, content_type="text/plain")

    async def ci_artifacts(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        artifacts = CI_ARTIFACTS.get(request.match_info["run_id"], [])
        return web.json_response({
            "total_count": len(artifacts),
            "artifacts": artifacts,
        })

    async def ci_artifact_zip(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        return web.Response(body=CI_ARTIFACT_ZIP,
                            content_type="application/zip")

    async def ci_annotations(self, request: web.Request) -> web.Response:
        guard = await self._ci_guard(request)
        if guard is not None:
            return guard
        anns = CI_ANNOTATIONS.get(request.match_info["check_run_id"], [])
        return web.json_response(anns)


def build_app(server: GitHubServer) -> web.Application:
    app = web.Application()
    app.router.add_get("/repos/{owner}/{repo}", server.repo_info)
    app.router.add_get("/repos/{owner}/{repo}/git/trees/{ref}", server.tree)
    app.router.add_get("/repos/{owner}/{repo}/git/blobs/{sha}", server.blob)
    app.router.add_get("/search/code", server.search_code)
    app.router.add_get("/repos/{owner}/{repo}/actions/workflows",
                       server.ci_workflows)
    app.router.add_get("/repos/{owner}/{repo}/actions/workflows/{workflow_id}",
                       server.ci_workflow)
    app.router.add_get("/repos/{owner}/{repo}/actions/runs", server.ci_runs)
    app.router.add_get("/repos/{owner}/{repo}/actions/runs/{run_id}",
                       server.ci_run)
    app.router.add_get("/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
                       server.ci_jobs)
    app.router.add_get("/repos/{owner}/{repo}/actions/jobs/{job_id}",
                       server.ci_job)
    app.router.add_get("/repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
                       server.ci_job_logs)
    app.router.add_get("/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
                       server.ci_artifacts)
    app.router.add_get(
        "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip",
        server.ci_artifact_zip)
    app.router.add_get(
        "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
        server.ci_annotations)
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
        if not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        # A SUBMODULES file at the fixture root is a manifest of submodule
        # gitlink paths (one per line), not repository content.
        if relative == "SUBMODULES":
            for line in path.read_text().splitlines():
                if line.strip():
                    repo.seed_submodule(line.strip())
            continue
        repo.seed_path(relative, path.read_bytes())


async def _serve(port: int, repos: list[str]) -> None:
    state = FakeGitHub()
    fixtures = Path(__file__).resolve().parents[1] / "fixtures"
    for spec in repos:
        full_name, _, fixture = spec.partition("=")
        fixture, _, flag = fixture.partition(":")
        seed_from_dir(state, full_name, fixtures / fixture)
        if flag == "truncated":
            state.repos[full_name].truncated = True
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
        help="owner/name=<fixture dir under integ/fixtures>[:truncated], "
        "repeatable")
    args = parser.parse_args()
    asyncio.run(_serve(args.port, args.repo))


if __name__ == "__main__":
    main()
