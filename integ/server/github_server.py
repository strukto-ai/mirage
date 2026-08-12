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
import json
import re
import sys
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
DEFAULT_LOGIN = "integ-user"


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


async def _json_body(request: web.Request) -> dict:
    """Read a JSON body, treating an absent or malformed one as empty.

    Args:
        request (web.Request): the incoming request.

    Returns:
        dict: the decoded object, or {}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def _repo_json(repo: "FakeRepo") -> dict:
    """The repository shape every route returns.

    Args:
        repo (FakeRepo): the repository.

    Returns:
        dict: its JSON form.
    """
    return {
        "name": repo.name,
        "full_name": repo.full_name,
        "default_branch": repo.default_branch,
        "owner": {
            "login": repo.owner
        },
        "html_url": f"https://github.com/{repo.full_name}",
        "description": None,
        "stargazers_count": 0,
        "forks_count": 0,
        "open_issues_count": 0,
        "language": None,
        "topics": [],
        "archived": False,
        "fork": False,
        # A fixture's own values win: `default_branch` is decided by seeding
        # and the rest is metadata only a fixture knows.
        **{
            k: v
            for k, v in repo.meta.items() if k != "default_branch"
        },
    }


def _commit_list(repo: "FakeRepo", branch: str = "") -> list[dict]:
    """One branch's commits, newest first, with a synthetic root.

    Every branch has a root commit so that "the latest commit" is
    answerable before anything is written, and the two branches of a
    fixture do not share a head.

    Args:
        repo (FakeRepo): the repository.
        branch (str): the branch, or "" for the default one.

    Returns:
        list[dict]: the commit list.
    """
    target = branch or repo.default_branch
    # Derived from the branch's content, not from the repository's name, so
    # that a mirror of a repository has the same root sha as its source --
    # which is what `git clone --mirror` followed by a push actually does,
    # and what a grader comparing a local copy against its upstream relies
    # on. Two branches differ here exactly when their trees differ.
    tree = sorted(
        (path, _blob_sha(data))
        for path, data in repo.trees_by_branch.get(target, {}).items())
    root = {
        "sha": _commit_sha("root\0" + "\0".join(f"{p}:{b}" for p, b in tree)),
        "commit": {
            "message": "Initial commit"
        },
        "files": [],
    }
    written = repo.commits_by_branch.get(target, [])
    return [*reversed(written), root]


def _record_commit(repo: "FakeRepo",
                   message: str,
                   paths: list[str],
                   branch: str = "") -> dict:
    """Append a commit for a write to one branch and return it.

    Args:
        repo (FakeRepo): the repository written to.
        message (str): the commit message.
        paths (list[str]): the paths the commit touched.
        branch (str): the branch written to, or "" for the default one.

    Returns:
        dict: the recorded commit.
    """
    target = branch or repo.default_branch
    written = repo.commits_by_branch.setdefault(target, [])
    commit = {
        "sha":
        _commit_sha(f"{repo.full_name}@{target}:{len(written)}:{message}"),
        "commit": {
            "message": message
        },
        "files": list(paths),
    }
    written.append(commit)
    return commit


def _branch_json(repo: "FakeRepo", branch: str = "") -> dict:
    """One branch, pointing at its newest commit.

    Args:
        repo (FakeRepo): the repository.
        branch (str): the branch, or "" for the default one.

    Returns:
        dict: the branch object.
    """
    target = branch or repo.default_branch
    return {
        "name": target,
        "commit": {
            "sha": _commit_list(repo, target)[0]["sha"]
        },
    }


def _content_json(repo: "FakeRepo",
                  path: str,
                  files: dict[str, bytes] | None = None) -> dict:
    """One file as a contents object.

    Args:
        repo (FakeRepo): the repository.
        path (str): path within it.
        files (dict[str, bytes] | None): the branch's files, or None for
            the default branch's.

    Returns:
        dict: the base64-encoded content object.
    """
    data = (repo.files if files is None else files)[path]
    return {
        "type": "file",
        "name": path.rsplit("/", 1)[-1],
        "path": path,
        "sha": _blob_sha(data),
        "size": len(data),
        "encoding": "base64",
        "content": base64.b64encode(data).decode("ascii"),
    }


def _directory_json(
        repo: "FakeRepo",
        path: str,
        files: dict[str, bytes] | None = None) -> list[dict] | None:
    """A directory listing, or None when the path is not a directory.

    Args:
        repo (FakeRepo): the repository.
        path (str): directory path, "" for the root.
        files (dict[str, bytes] | None): the branch's files, or None for
            the default branch's.

    Returns:
        list[dict] | None: the entries, or None.
    """
    at = repo.files if files is None else files
    prefix = f"{path}/" if path else ""
    if path and path not in repo.directories(at):
        return None
    entries: dict[str, dict] = {}
    for candidate in at:
        if not candidate.startswith(prefix):
            continue
        rest = candidate[len(prefix):]
        head, _, tail = rest.partition("/")
        if tail:
            entries.setdefault(
                head, {
                    "type": "dir",
                    "name": head,
                    "path": f"{prefix}{head}",
                    "sha": _tree_sha(f"{prefix}{head}"),
                    "size": 0,
                })
        else:
            data = at[candidate]
            entries[head] = {
                "type": "file",
                "name": head,
                "path": candidate,
                "sha": _blob_sha(data),
                "size": len(data),
            }
    return [entries[name] for name in sorted(entries)]


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
        # Repository metadata, for a task that picks between repositories
        # rather than reading inside one. Anything a fixture does not set
        # keeps GitHub's own value for a fresh repository.
        self.meta: dict = {}
        # One file map and one commit list per branch. `files` and `commits`
        # below stay bound to the default branch, so every route that does
        # not name a ref keeps reading what it always read; a route that
        # does name one goes through `tree_of` / `commits_of`.
        self.trees_by_branch: dict[str, dict[str, bytes]] = {
            default_branch: {}
        }
        self.commits_by_branch: dict[str, list[dict]] = {default_branch: []}
        self.terms: dict[str, set[str]] = {}
        self.blobs: dict[str, bytes] = {}
        self.submodules: set[str] = set()
        self.truncated = False
        # Write state. The read routes describe a repository as it is; a
        # task that files an issue or commits a file needs the write to be
        # visible to the next read, so both live here rather than being
        # accepted and dropped.
        self.issues: list[dict] = []
        # Staged trees, and which one each commit points at. A multi-file
        # write builds a tree, commits it and then moves the branch, and
        # only that last step is allowed to change what a read returns.
        self.trees: dict[str, dict[str, bytes]] = {}
        self.commit_trees: dict[str, str] = {}

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def files(self) -> dict[str, bytes]:
        return self.trees_by_branch[self.default_branch]

    @files.setter
    def files(self, value: dict[str, bytes]) -> None:
        self.trees_by_branch[self.default_branch] = value

    @property
    def commits(self) -> list[dict]:
        return self.commits_by_branch.setdefault(self.default_branch, [])

    @property
    def branch_names(self) -> list[str]:
        """Branches, the default one first and the rest in name order."""
        rest = sorted(b for b in self.trees_by_branch
                      if b != self.default_branch)
        return [self.default_branch, *rest]

    def branch_for(self, ref: str | None) -> str | None:
        """The branch a ref names, or None if it names nothing.

        A ref is a branch name, HEAD, the empty string, or a commit sha
        belonging to one branch's history.

        Args:
            ref (str | None): the ref as the caller spelled it.

        Returns:
            str | None: the branch name, or None.
        """
        if not ref or ref == "HEAD":
            return self.default_branch
        if ref in self.trees_by_branch:
            return ref
        for branch in self.trees_by_branch:
            if any(c["sha"] == ref for c in _commit_list(self, branch)):
                return branch
        return None

    def tree_of(self, ref: str | None) -> dict[str, bytes] | None:
        """The file map at a ref, or None if the ref is unknown.

        Args:
            ref (str | None): the ref as the caller spelled it.

        Returns:
            dict[str, bytes] | None: that branch's files.
        """
        branch = self.branch_for(ref)
        return None if branch is None else self.trees_by_branch[branch]

    def seed_path(self, path: str, data: bytes, branch: str = "") -> None:
        key = path.strip("/")
        target = branch or self.default_branch
        self.trees_by_branch.setdefault(target, {})[key] = data
        self.blobs[_blob_sha(data)] = data
        if target == self.default_branch:
            self._index(key, data)

    def replace_files(self, files: dict[str, bytes], branch: str = "") -> None:
        """Make a staged tree a branch's contents.

        Args:
            files (dict[str, bytes]): the tree to check out.
            branch (str): the branch to move, or "" for the default one.
        """
        target = branch or self.default_branch
        self.trees_by_branch[target] = {}
        if target == self.default_branch:
            self.terms = {}
        for path, data in files.items():
            self.seed_path(path, data, target)

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

    def directories(self, files: dict[str, bytes] | None = None) -> set[str]:
        dirs: set[str] = set()
        for path in (self.files if files is None else files):
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add("/".join(parts[:i]))
        return dirs

    def blob(self, sha: str) -> bytes | None:
        return self.blobs.get(sha)

    def tree_items(
            self,
            scope: str = "",
            files: dict[str, bytes] | None = None) -> list[dict[str, object]]:
        """Recursive tree entries, optionally rooted at a subdirectory.

        Args:
            scope (str): directory to root at, or "" for the whole repo.
            files (dict[str, bytes] | None): the branch's files, or None
                for the default branch's.

        Returns:
            list[dict[str, object]]: entries in git's path order, blobs
            carrying a size and trees carrying none.
        """
        at = self.files if files is None else files
        prefix = f"{scope}/" if scope else ""
        items: list[dict[str, object]] = []
        for path in sorted(self.directories(at)):
            if not path.startswith(prefix) or path == scope:
                continue
            items.append({
                "path": path[len(prefix):],
                "mode": "040000",
                "type": "tree",
                "sha": _tree_sha(path),
            })
        for path, data in sorted(at.items()):
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
        # Whoever the token belongs to. A task that forks or creates a
        # repository has to be told where it landed, and every caller
        # resolves that by asking /user first.
        self.login = DEFAULT_LOGIN

    def repo(self,
             owner: str,
             name: str,
             default_branch: str = DEFAULT_BRANCH) -> FakeRepo:
        key = f"{owner}/{name}"
        if key not in self.repos:
            self.repos[key] = FakeRepo(owner, name, default_branch)
        return self.repos[key]

    def rename(self, repo: FakeRepo, name: str) -> None:
        """Move a repository to a new name under the same owner.

        Args:
            repo (FakeRepo): the repository to rename.
            name (str): its new name.
        """
        self.repos.pop(repo.full_name, None)
        repo.name = name
        self.repos[repo.full_name] = repo


class GitHubServer:
    """The four read-only api.github.com routes the github backend calls.

    Args:
        state (FakeGitHub): the backing repository store.
    """

    def __init__(self, state: FakeGitHub) -> None:
        self.state = state

    def _authed(self, request: web.Request) -> bool:
        return bool(request.headers.get("Authorization"))

    def _ref(self, request: web.Request) -> str:
        """The ref a request names, from `?ref=` or a `branch` body field.

        Args:
            request (web.Request): the incoming request.

        Returns:
            str: the ref, or "" for the default branch.
        """
        return request.query.get("ref", "")

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

    async def user(self, request: web.Request) -> web.Response:
        """Who the token belongs to, which every write path resolves first.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the authenticated user.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        return web.json_response({
            "login": self.state.login,
            "name": self.state.login,
            "type": "User",
        })

    async def list_repos(self, request: web.Request) -> web.Response:
        """One account's repositories.

        Serves `/users/{login}/repos` and `/user/repos`. A task that asks
        "is there a repository for this on my GitHub" answers it here, and
        a 404 would read as "the account has none".

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the account's repositories, in name order.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        owner = request.match_info.get("owner", self.state.login)
        items = [
            _repo_json(repo) for name, repo in sorted(self.state.repos.items())
            if repo.owner == owner
        ]
        return web.json_response(items)

    async def create_repo(self, request: web.Request) -> web.Response:
        """Create a repository under the authenticated user.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the created repository, or 422 if it exists.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        body = await _json_body(request)
        name = str(body.get("name") or "").strip()
        if not name:
            return _error(422, "Repository creation failed.")
        key = f"{self.state.login}/{name}"
        if key in self.state.repos:
            return _error(422, "Repository creation failed.")
        repo = self.state.repo(self.state.login, name)
        return web.json_response(_repo_json(repo), status=201)

    async def update_repo(self, request: web.Request) -> web.Response:
        """Rename a repository, or move its default branch.

        A task that forks a template and renames the fork does it here, so
        the rename has to carry the content with it rather than leaving an
        empty repository behind under the new name.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the updated repository, or 422 on a name clash.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        body = await _json_body(request)
        name = str(body.get("name") or "").strip()
        if name and name != repo.name:
            if f"{repo.owner}/{name}" in self.state.repos:
                return _error(422, "Repository creation failed.")
            self.state.rename(repo, name)
        branch = str(body.get("default_branch") or "").strip()
        if branch:
            repo.default_branch = branch
        return web.json_response(_repo_json(repo))

    async def delete_repo(self, request: web.Request) -> web.Response:
        """Delete a repository, as a task's preprocess does before seeding.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: 204, or 404 when there was nothing to delete.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        owner = request.match_info["owner"]
        name = request.match_info["repo"]
        if self.state.repos.pop(f"{owner}/{name}", None) is None:
            return _error(404, "Not Found")
        return web.Response(status=204)

    async def fork_repo(self, request: web.Request) -> web.Response:
        """Fork into the authenticated user's namespace.

        The copy is deep: a fork the agent then commits to must not write
        through to the source, which is what upstream's own preprocess
        relies on when it forks an archive repository per run.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the newly created fork.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        source = self._lookup(request)
        if source is None:
            return _error(404, "Not Found")
        # GitHub lets the fork be named at creation time, which is how a
        # caller avoids a two-step fork-then-rename.
        body = await _json_body(request)
        name = str(body.get("name") or "").strip() or source.name
        fork = self.state.repo(self.state.login, name)
        fork.default_branch = source.default_branch
        fork.submodules = set(source.submodules)
        fork.meta.update(source.meta)
        for branch, files in source.trees_by_branch.items():
            fork.trees_by_branch.setdefault(branch, {})
            for path, data in files.items():
                fork.seed_path(path, data, branch)
        return web.json_response(_repo_json(fork), status=202)

    async def branches(self, request: web.Request) -> web.Response:
        """List branches, the default one first.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: a one-entry branch list.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        return web.json_response(
            [_branch_json(repo, b) for b in repo.branch_names])

    async def branch(self, request: web.Request) -> web.Response:
        """One branch by name.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the branch, or 404 if it is not the default one.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        name = request.match_info["branch"]
        if name not in repo.trees_by_branch:
            return _error(404, "Branch not found")
        return web.json_response(_branch_json(repo, name))

    async def commits(self, request: web.Request) -> web.Response:
        """Commit history, newest first.

        Every seeded repository has one synthetic root commit so that
        "the latest commit" is answerable before the agent writes anything.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the commit list.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        return web.json_response(
            _commit_list(
                repo,
                repo.branch_for(request.query.get("sha", ""))
                or repo.default_branch))

    async def commit(self, request: web.Request) -> web.Response:
        """One commit by sha or by ref, with the paths it touched.

        `/commits/{ref}` and `/git/commits/{sha}` are different endpoints:
        this one takes a branch name as well as a sha and reports the file
        list, which is what a caller asking "what changed" reads.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the commit, or 404.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        ref = request.match_info["ref"]
        branch = repo.branch_for(ref)
        history = _commit_list(repo, branch or repo.default_branch)
        if ref in (*repo.trees_by_branch, "HEAD"):
            return web.json_response(history[0])
        for entry in history:
            if entry["sha"] == ref:
                return web.json_response(entry)
        return _error(404, "Not Found")

    async def contents(self, request: web.Request) -> web.Response:
        """Read a file or list a directory.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: a content object, or a list of them for a
                directory, matching GitHub's own shape.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        files = repo.tree_of(self._ref(request))
        if files is None:
            return _error(404, "No commit found for the ref")
        path = request.match_info.get("path", "").strip("/")
        if path in files:
            return web.json_response(_content_json(repo, path, files))
        listing = _directory_json(repo, path, files)
        if listing is None:
            return _error(404, "Not Found")
        return web.json_response(listing)

    async def put_contents(self, request: web.Request) -> web.Response:
        """Create or update a file, the way `PUT /contents` does.

        GitHub requires the current blob sha to replace an existing file
        and refuses one for a new file; both are enforced here, because a
        task that reads before writing is doing so for this reason.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the written content plus a synthetic commit.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        body = await _json_body(request)
        path = request.match_info.get("path", "").strip("/")
        raw = body.get("content")
        if raw is None:
            return _error(422,
                          "Invalid request.\n\n\"content\" wasn't supplied.")
        try:
            data = base64.b64decode(str(raw), validate=True)
        except Exception:  # noqa: BLE001
            return _error(422, "Invalid request.\n\n\"content\" is invalid.")
        branch = repo.branch_for(str(body.get("branch") or ""))
        if branch is None:
            return _error(404, "Branch not found")
        files = repo.trees_by_branch[branch]
        existing = files.get(path)
        given = body.get("sha")
        if existing is not None and given != _blob_sha(existing):
            return _error(409, f"{path} does not match")
        if existing is None and given:
            return _error(422, "Invalid request.\n\n\"sha\" wasn't supplied.")
        created = existing is None
        repo.seed_path(path, data, branch)
        commit = _record_commit(repo,
                                str(body.get("message") or f"Update {path}"),
                                [path], branch)
        return web.json_response(
            {
                "content": _content_json(repo, path, files),
                "commit": commit,
            },
            status=201 if created else 200)

    async def search_repos(self, request: web.Request) -> web.Response:
        """Find repositories by substring, over everything the fake holds.

        Substring rather than GitHub's own qualifier grammar, which nothing
        here parses. It is here at all because the alternative is a 404, and
        a caller reads that as "no such repository" -- an agent looking for
        the fork it just made would conclude it had not made one.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the matching repositories.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        query = request.query.get("q", "").lower()
        # Qualifiers (`user:x`, `in:name`) are dropped rather than honoured;
        # what is left is matched against the name and the description,
        # because a repository is found by what it says it does at least as
        # often as by what it is called. Terms OR together rather than AND,
        # which is looser than GitHub and errs towards showing a caller the
        # row it is looking for; a hyphenated term also matches its parts.
        terms: list[str] = []
        for word in query.split():
            if ":" in word:
                continue
            terms.append(word)
            terms.extend(p for p in re.split(r"[-_]", word) if len(p) > 2)
        matched = []
        for name, repo in self.state.repos.items():
            haystack = f"{name} {repo.meta.get('description') or ''}".lower()
            if not terms or any(t in haystack for t in terms):
                matched.append(repo)
        # GitHub's default is relevance, which is not modelled; `sort=stars`
        # is, because a task that asks for "the most starred" is asking for
        # exactly this ordering.
        reverse = request.query.get("order", "desc") != "asc"
        if request.query.get("sort") == "stars":
            matched.sort(
                key=lambda r: int(r.meta.get("stargazers_count") or 0),
                reverse=reverse)
        else:
            matched.sort(key=lambda r: r.full_name)
        items = [_repo_json(repo) for repo in matched]
        return web.json_response({
            "total_count": len(items),
            "incomplete_results": False,
            "items": items,
        })

    async def git_commit(self, request: web.Request) -> web.Response:
        """One commit by sha, with the tree it points at.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the commit object, or 404.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        sha = request.match_info["sha"]
        for commit in _commit_list(repo):
            if commit["sha"] == sha:
                return web.json_response({
                    "sha": sha,
                    "message": commit["commit"]["message"],
                    "tree": {
                        "sha": repo.commit_trees.get(sha, _tree_sha(""))
                    },
                })
        return _error(404, "Not Found")

    async def create_tree(self, request: web.Request) -> web.Response:
        """Stage a tree. Nothing becomes visible until a ref points at it.

        This is the multi-file write path: a caller builds a tree, commits
        it, then moves the branch. Applying the files here instead would
        make a tree that is never committed show up in the repository, which
        is the kind of difference a task only notices as a wrong answer.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the staged tree's sha.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        body = await _json_body(request)
        base = str(body.get("base_tree") or "")
        files = dict(repo.trees.get(base, repo.files))
        entries = body.get("tree")
        if not isinstance(entries, list):
            return _error(422, "Invalid request.\n\n\"tree\" wasn't supplied.")
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            path = str(entry.get("path") or "").strip("/")
            if not path:
                continue
            # A null sha is git's delete; content is the inline form and a
            # sha names a blob the caller wrote earlier.
            if "sha" in entry and entry["sha"] is None:
                files.pop(path, None)
            elif entry.get("content") is not None:
                files[path] = str(entry["content"]).encode()
            elif entry.get("sha"):
                blob = repo.blob(str(entry["sha"]))
                if blob is None:
                    return _error(422, f"Tree entry {path} has an unknown sha")
                files[path] = blob
        sha = _tree_sha(f"{repo.full_name}:{len(repo.trees)}")
        repo.trees[sha] = files
        return web.json_response({"sha": sha, "tree": []}, status=201)

    async def create_commit(self, request: web.Request) -> web.Response:
        """Record a commit against a staged tree.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the new commit.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        body = await _json_body(request)
        tree = str(body.get("tree") or "")
        if tree not in repo.trees:
            return _error(422, "Invalid request.\n\n\"tree\" is invalid.")
        staged = repo.trees[tree]
        touched = sorted(
            set(staged) ^ set(repo.files)
            | {p
               for p, d in staged.items() if repo.files.get(p) != d})
        commit = _record_commit(repo, str(body.get("message") or "Update"),
                                sorted(touched))
        repo.commit_trees[commit["sha"]] = tree
        return web.json_response(
            {
                "sha": commit["sha"],
                "message": commit["commit"]["message"],
                "tree": {
                    "sha": tree
                },
            },
            status=201)

    async def update_ref(self, request: web.Request) -> web.Response:
        """Move a branch, which is what makes a staged tree visible.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the moved reference.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        ref = request.match_info["ref"].strip("/")
        name = ref[len("heads/"):] if ref.startswith("heads/") else ""
        if name not in repo.trees_by_branch:
            return _error(422, "Reference does not exist")
        body = await _json_body(request)
        sha = str(body.get("sha") or "")
        tree = repo.commit_trees.get(sha)
        if tree is None:
            return _error(422, "Invalid request.\n\n\"sha\" is invalid.")
        repo.replace_files(repo.trees[tree], name)
        return web.json_response({
            "ref": f"refs/{ref}",
            "object": {
                "sha": sha,
                "type": "commit"
            },
        })

    async def readme(self, request: web.Request) -> web.Response:
        """The repository's README as a contents object.

        GitHub picks the first of several spellings; the fake checks the
        same ones. A repository seeded as metadata only has no files, so
        this answers 404 -- which is what GitHub says for a repository with
        no README, and now means that rather than "no such endpoint".

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the README, or 404.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        files = repo.tree_of(self._ref(request))
        if files is None:
            return _error(404, "Not Found")
        for name in ("README.md", "README", "README.rst", "README.txt",
                     "readme.md"):
            if name in files:
                return web.json_response(_content_json(repo, name, files))
        return _error(404, "Not Found")

    async def delete_contents(self, request: web.Request) -> web.Response:
        """Delete a file, the way `DELETE /contents` does.

        GitHub requires the current blob sha here as it does for a replace,
        and answers 404 for a path that is not there.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the deleting commit, or an error.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        path = request.match_info.get("path", "").strip("/")
        body = await _json_body(request)
        branch = repo.branch_for(str(body.get("branch") or ""))
        if branch is None:
            return _error(404, "Branch not found")
        files = repo.trees_by_branch[branch]
        existing = files.get(path)
        if existing is None:
            return _error(404, "Not Found")
        if body.get("sha") != _blob_sha(existing):
            return _error(409, f"{path} does not match")
        remaining = dict(files)
        remaining.pop(path)
        repo.replace_files(remaining, branch)
        commit = _record_commit(repo,
                                str(body.get("message") or f"Delete {path}"),
                                [path], branch)
        return web.json_response({"content": None, "commit": commit})

    async def list_issues(self, request: web.Request) -> web.Response:
        """List issues, newest first, filtered by state.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the issue list.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        wanted = request.query.get("state", "open")
        issues = [
            issue for issue in reversed(repo.issues)
            if wanted == "all" or issue["state"] == wanted
        ]
        return web.json_response(issues)

    async def create_issue(self, request: web.Request) -> web.Response:
        """File an issue.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the created issue.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        body = await _json_body(request)
        title = str(body.get("title") or "").strip()
        if not title:
            return _error(422,
                          "Invalid request.\n\n\"title\" wasn't supplied.")
        labels = body.get("labels") or []
        issue = {
            "number":
            len(repo.issues) + 1,
            "title":
            title,
            "body":
            body.get("body") or "",
            "state":
            "open",
            "user": {
                "login": self.state.login
            },
            "labels": [{
                "name": str(name)
            } for name in labels],
            "html_url": (f"{self.state.base}/{repo.full_name}"
                         f"/issues/{len(repo.issues) + 1}"),
        }
        repo.issues.append(issue)
        return web.json_response(issue, status=201)

    async def compare(self, request: web.Request) -> web.Response:
        """Files changed between two refs.

        The fake has one branch, so a comparison is answered from the
        commits recorded since the base rather than from a real diff --
        enough for "which files did the agent touch", which is what the
        graders ask.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: a comparison carrying the changed files.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        spec = request.match_info.get("basehead", "")
        base = spec.split("...")[0] if "..." in spec else ""
        history = _commit_list(repo)
        known = {commit["sha"] for commit in history}
        # A base this repository has never heard of is an error, not an
        # empty diff. Answering "nothing changed" to a question about an
        # unrelated commit is the shape of wrongness that reads as success.
        if base and base not in known and base != repo.default_branch:
            return _error(404, "No common ancestor between the two commits")
        # `history` is newest first, so everything *before* the base is
        # what came after it in time. Walking past the base instead would
        # collect the commits the base already contains.
        touched: list[str] = []
        for commit in history:
            if base and commit["sha"] == base:
                break
            touched.extend(commit.get("files", []))
        files = [{
            "filename": path,
            "status": "modified"
        } for path in dict.fromkeys(touched)]
        return web.json_response({
            "status": "ahead",
            "files": files,
            "commits": [],
        })

    async def raw_content(self, request: web.Request) -> web.Response:
        """Serve a file's bytes the way raw.githubusercontent.com does.

        A client reading one file fetches it from the raw host rather than
        the API, and decides text from binary by the Content-Type it gets
        back, so serving everything as octet-stream would base64 the whole
        repository. The fixture is text apart from the stubbed binaries, so
        the split is on whether the bytes decode as UTF-8.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the file's bytes, or 404.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        files = repo.tree_of(request.match_info.get("ref", ""))
        if files is None:
            return _error(404, "Not Found")
        path = request.match_info["path"].strip("/")
        data = files.get(path)
        if data is None:
            return _error(404, "Not Found")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            content_type = "application/octet-stream"
        else:
            content_type = "text/plain; charset=utf-8"
        return web.Response(body=data, content_type=content_type.split(";")[0])

    async def unrouted(self, request: web.Request) -> web.Response:
        """Answer 404 for an endpoint the fake does not implement, loudly.

        A real client treats a 404 as an answer -- "no such ref", "no such
        file" -- so an unimplemented endpoint is indistinguishable from a
        negative result, and the caller reports a plausible wrong conclusion
        instead of an error. Naming it on stderr is what turns that into a
        visible gap.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: 404.
        """
        print(f"github fake: no route for {request.method} {request.path}",
              file=sys.stderr,
              flush=True)
        return _error(404, "Not Found")

    async def git_refs(self, request: web.Request) -> web.Response:
        """Every ref under a prefix, as a list.

        `git/ref/<full-ref>` returns one object and `git/refs/<prefix>` a
        list of everything beneath it; the two are different endpoints and
        a caller picks whichever it expects, so serving only the singular
        makes the plural read as "no such ref".

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the matching references.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        prefix = request.match_info["ref"].strip("/")
        items = [{
            "ref": f"refs/heads/{name}",
            "object": {
                "sha": _commit_list(repo, name)[0]["sha"],
                "type": "commit",
            },
        } for name in repo.branch_names if f"heads/{name}".startswith(prefix)]
        if not items:
            return _error(404, "Not Found")
        return web.json_response(items)

    async def git_ref(self, request: web.Request) -> web.Response:
        """Resolve `refs/heads/<branch>` or `refs/tags/<tag>` to a commit.

        A client that takes a `ref` argument resolves it here before reading
        anything, trying the branch spelling and then the tag spelling, so a
        404 on this route reads to it as "no such ref" rather than as a
        missing endpoint. The fake keeps one branch and no tags.

        Args:
            request (web.Request): the incoming request.

        Returns:
            web.Response: the reference object, or 404.
        """
        if not self._authed(request):
            return _error(401, "Requires authentication")
        repo = self._lookup(request)
        if repo is None:
            return _error(404, "Not Found")
        ref = request.match_info["ref"].strip("/")
        name = ref[len("heads/"):] if ref.startswith("heads/") else ""
        if name not in repo.trees_by_branch:
            return _error(404, "Not Found")
        return web.json_response({
            "ref": f"refs/{ref}",
            "object": {
                "sha": _commit_list(repo, name)[0]["sha"],
                "type": "commit",
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
        # A ref is also resolved through `branch_for`, which accepts a commit
        # sha, because a client that resolves a ref to a commit first then
        # asks for the tree by that sha -- git accepts it, since a commit
        # names its root tree.
        scope = ""
        files = repo.tree_of(ref)
        if files is None:
            matches = [
                d for d in repo.directories(repo.files) if _tree_sha(d) == ref
            ]
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
        items = repo.tree_items(scope, files)
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


def _add_routes(app: web.Application, server: "GitHubServer",
                prefix: str) -> None:
    """Register every route once under one path prefix.

    Args:
        app (web.Application): the application to register on.
        server (GitHubServer): the handler set.
        prefix (str): "" for github.com, "/api/v3" for Enterprise.
    """
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}", server.repo_info)
    # Write and listing routes. Ordered before the tree routes only for
    # readability; aiohttp matches on the full pattern, not on order.
    app.router.add_get(f"{prefix}/user", server.user)
    app.router.add_get(f"{prefix}/user/repos", server.list_repos)
    app.router.add_post(f"{prefix}/user/repos", server.create_repo)
    app.router.add_get(f"{prefix}/users/{{owner}}/repos", server.list_repos)
    app.router.add_patch(f"{prefix}/repos/{{owner}}/{{repo}}",
                         server.update_repo)
    app.router.add_delete(f"{prefix}/repos/{{owner}}/{{repo}}",
                          server.delete_repo)
    app.router.add_post(f"{prefix}/repos/{{owner}}/{{repo}}/forks",
                        server.fork_repo)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/readme",
                       server.readme)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/branches",
                       server.branches)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/branches/{{branch}}",
        server.branch)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/commits",
                       server.commits)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/commits/{{ref}}",
                       server.commit)
    # Both spellings of the repository root: GitHub serves `/contents` as
    # well as `/contents/`, and a caller listing the root picks either.
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/contents",
                       server.contents)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/contents/{{path:.*}}",
        server.contents)
    app.router.add_put(
        f"{prefix}/repos/{{owner}}/{{repo}}/contents/{{path:.*}}",
        server.put_contents)
    app.router.add_delete(
        f"{prefix}/repos/{{owner}}/{{repo}}/contents/{{path:.*}}",
        server.delete_contents)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/issues",
                       server.list_issues)
    app.router.add_post(f"{prefix}/repos/{{owner}}/{{repo}}/issues",
                        server.create_issue)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/compare/{{basehead}}",
        server.compare)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/git/ref/{{ref:.*}}",
                       server.git_ref)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/git/refs/{{ref:.*}}",
        server.git_refs)
    app.router.add_patch(
        f"{prefix}/repos/{{owner}}/{{repo}}/git/refs/{{ref:.*}}",
        server.update_ref)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/git/commits/{{sha}}",
        server.git_commit)
    app.router.add_post(f"{prefix}/repos/{{owner}}/{{repo}}/git/commits",
                        server.create_commit)
    app.router.add_post(f"{prefix}/repos/{{owner}}/{{repo}}/git/trees",
                        server.create_tree)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/git/trees/{{ref}}",
                       server.tree)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/git/blobs/{{sha}}",
                       server.blob)
    app.router.add_get(f"{prefix}/search/code", server.search_code)
    app.router.add_get(f"{prefix}/search/repositories", server.search_repos)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/actions/workflows",
                       server.ci_workflows)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/workflows/{{workflow_id}}",
        server.ci_workflow)
    app.router.add_get(f"{prefix}/repos/{{owner}}/{{repo}}/actions/runs",
                       server.ci_runs)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/runs/{{run_id}}",
        server.ci_run)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/runs/{{run_id}}/jobs",
        server.ci_jobs)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/jobs/{{job_id}}",
        server.ci_job)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/jobs/{{job_id}}/logs",
        server.ci_job_logs)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/runs/{{run_id}}/artifacts",
        server.ci_artifacts)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/actions/artifacts/"
        f"{{artifact_id}}/zip", server.ci_artifact_zip)
    app.router.add_get(
        f"{prefix}/repos/{{owner}}/{{repo}}/check-runs/"
        f"{{check_run_id}}/annotations", server.ci_annotations)


def build_app(server: GitHubServer) -> web.Application:
    """Serve the API at the root and under the Enterprise prefix.

    A client pointed at a host that is not github.com talks to GitHub
    Enterprise, which serves REST under `/api/v3/`. Toolathlon's MCP server
    is reached that way -- its `--gh-host` is the only place a base URL can
    be set -- while mirage's own backend and the graders call the dotcom
    paths. Both are the same handlers.

    Args:
        server (GitHubServer): the handler set.

    Returns:
        web.Application: the configured application.
    """
    app = web.Application()
    for prefix in ("", "/api/v3"):
        _add_routes(app, server, prefix)
    # The raw host is not the API host on github.com, but an Enterprise
    # install serves both from one origin, under /raw/. The ref segment is
    # a branch name or a commit sha and the fake keeps one of each, so it
    # is matched and ignored.
    app.router.add_get("/raw/{owner}/{repo}/{ref}/{path:.*}",
                       server.raw_content)
    app.router.add_route("*", "/{tail:.*}", server.unrouted)
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


def seed_from_dir(state: FakeGitHub,
                  full_name: str,
                  source: Path,
                  default_branch: str = DEFAULT_BRANCH,
                  branch: str = "") -> None:
    """Load every file under a fixture directory into one branch.

    Called once per branch, so a two-branch fixture is two directories and
    two `--repo` flags naming the same repository.

    Args:
        state (FakeGitHub): the store to seed.
        full_name (str): "owner/name" of the repository to create.
        source (Path): fixture directory to walk.
        default_branch (str): branch the repository reports as default.
        branch (str): branch to load into, or "" for the default one.
    """
    owner, _, name = full_name.partition("/")
    repo = state.repo(owner, name, default_branch)
    if branch:
        repo.trees_by_branch.setdefault(branch, {})
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
        repo.seed_path(relative, path.read_bytes(), branch)


def seed_metadata(state: FakeGitHub, source: Path) -> None:
    """Create repositories that are metadata only, from one JSON file.

    A task that picks *between* repositories reads their descriptions, star
    counts and languages and never opens one, so the fixture is a map of
    "owner/name" to the fields the search and repo endpoints report. Any
    that a file tree is also seeded for keeps both.

    Args:
        state (FakeGitHub): the store to seed.
        source (Path): a JSON object keyed by full name.
    """
    for full_name, meta in json.loads(source.read_text()).items():
        owner, _, name = str(full_name).partition("/")
        branch = str(meta.get("default_branch") or DEFAULT_BRANCH)
        state.repo(owner, name, branch).meta.update(meta)


async def _serve(port: int, repos: list[str], metadata: list[str]) -> None:
    state = FakeGitHub()
    fixtures = Path(__file__).resolve().parents[1] / "fixtures"
    for spec in repos:
        full_name, _, fixture = spec.partition("=")
        # Flags are colon-separated and order-free: "truncated", or
        # "branch=<name>" for a template whose default is not `main`.
        fixture, _, rest = fixture.partition(":")
        flags = [f for f in rest.split(":") if f]
        default_branch = DEFAULT_BRANCH
        into = ""
        for flag in flags:
            if flag.startswith("branch="):
                default_branch = flag.split("=", 1)[1]
            elif flag.startswith("into="):
                into = flag.split("=", 1)[1]
        # A task outside this tree seeds from its own directory, so an
        # absolute fixture path has to win over the bundled one.
        seed_from_dir(state, full_name, fixtures / fixture, default_branch,
                      into)
        if "truncated" in flags:
            state.repos[full_name].truncated = True
    for spec in metadata:
        seed_metadata(state, fixtures / spec)
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
        help="owner/name=<fixture dir under integ/fixtures>[:truncated]"
        "[:branch=<default>][:into=<branch>], repeatable; repeat with "
        "into= to add a second branch to the same repository")
    parser.add_argument(
        "--metadata",
        action="append",
        default=[],
        help="JSON file of repositories that exist as metadata only, keyed "
        "by owner/name; repeatable")
    args = parser.parse_args()
    asyncio.run(_serve(args.port, args.repo, args.metadata))


if __name__ == "__main__":
    main()
