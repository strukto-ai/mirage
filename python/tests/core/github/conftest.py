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

import base64
import hashlib
import re
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qs, quote, unquote

import pytest_asyncio
from pydantic import SecretStr
from yarl import URL

from mirage.accessor.github import GitHubAccessor, GitHubAccount
from mirage.core.github.config import GhConfig, GitHubConfig
from tests.fixtures.kit_fake import KitRun

TOKEN = "unit"
OWNER = "integ-user"
REPO_ROUTE = "/repos/:owner/:repo"
TREES = "/repos/:owner/:repo/git/trees/*ref"
BLOBS = "/repos/:owner/:repo/git/blobs/:sha"
SEARCH = "/search/code"
GRAPHQL = "/graphql"
RAW = "/raw/:owner/:repo/:ref/*path"
UNTIL_CLEARED = 1_000_000
SHA40 = re.compile(r"^[0-9a-fA-F]{40}$")
NAMED: dict[str, tuple[str, str, str | None]] = {
    "dir": ("GET", TREES, ""),
    "recursive": ("GET", TREES, "recursive=1"),
    "blob": ("GET", BLOBS, None),
    "repo": ("GET", REPO_ROUTE, None),
    "search": ("GET", SEARCH, None),
}


def blob_sha(data: bytes) -> str:
    """The git blob sha of ``data``, as GitHub names a file's bytes.

    Args:
        data (bytes): the file's bytes.
    """
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


class GitHubRepo:
    """One repository on the GitHub fake, and the commits a test arranges it
    by.

    Every change is a commit on ``main`` made through the git database API,
    blobs then a tree then the commit, with the branch moved onto it, so the
    head moves the way a push moves it and every earlier commit, tree and
    blob stays readable by its sha, as on GitHub.

    Args:
        origin (str): the GitHub fake's origin.
        name (str): the repository's name.
    """

    def __init__(self, origin: str, name: str = "repo") -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})
        self.owner = OWNER
        self.name = name
        self.api = f"/repos/{OWNER}/{name}"

    def accessor(self, ref: str = "main") -> GitHubAccessor:
        """A Mirage accessor on this repository with a token.

        Args:
            ref (str): the ref it reads.
        """
        account = GitHubAccount(
            GhConfig(token=SecretStr(TOKEN), base_url=self.run.url)
        )
        return GitHubAccessor(account, self.owner, self.name, ref)

    def config(self, **fields: Any) -> GitHubConfig:
        """A mount config for this repository with a token.

        Args:
            **fields (Any): further GitHubConfig fields.
        """
        return GitHubConfig(
            token=SecretStr(TOKEN),
            base_url=self.run.url,
            owner=self.owner,
            repo=self.name,
            **fields,
        )

    async def create(
        self, files: dict[str, bytes], private: bool = False
    ) -> str:
        """Create the repository holding exactly ``files`` on ``main``, start
        recording the requests made to it, and return its head.

        Args:
            files (dict[str, bytes]): repo-relative path to bytes.
            private (bool): refuse a read with no credential.
        """
        await self.run.call(
            "POST",
            "/user/repos",
            json={"name": self.name, "auto_init": True, "private": private},
        )
        head = await self.replace(files)
        await self.run.record_requests()
        return head

    async def head(self, branch: str = "main") -> str:
        """The commit ``branch`` points at.

        Args:
            branch (str): the branch.
        """
        return str((await self.tree(branch))["sha"])

    async def paths(self) -> list[str]:
        """Every file path ``main`` holds."""
        tree = await self.tree("main", recursive=True)
        return [row["path"] for row in tree["tree"] if row["type"] == "blob"]

    async def commit(
        self, changes: dict[str, bytes | None], branch: str = "main"
    ) -> str:
        """Commit ``changes`` onto ``branch`` and return the new head.

        Args:
            changes (dict[str, bytes | None]): path to its new bytes, None
                to delete it.
            branch (str): the branch the commit moves.
        """
        entries: list[dict[str, Any]] = []
        for path, data in changes.items():
            sha = None
            if data is not None:
                blob = await self.run.call(
                    "POST",
                    f"{self.api}/git/blobs",
                    json={
                        "content": base64.b64encode(data).decode(),
                        "encoding": "base64",
                    },
                )
                sha = blob["sha"]
            entries.append(
                {"path": path, "mode": "100644", "type": "blob", "sha": sha}
            )
        return await self._commit_entries(entries, branch)

    async def link(self, path: str, commit: str) -> str:
        """Commit a submodule gitlink at ``path`` naming ``commit`` onto
        ``main`` and return the new head.

        Args:
            path (str): where the submodule sits.
            commit (str): the commit it pins.
        """
        return await self._commit_entries(
            [{"path": path, "mode": "160000", "type": "commit", "sha": commit}]
        )

    async def branch(self, name: str) -> None:
        """Start branch ``name`` at the commit ``main`` points at.

        Args:
            name (str): the branch's name.
        """
        await self.run.call(
            "POST",
            f"{self.api}/git/refs",
            json={"ref": f"refs/heads/{name}", "sha": await self.head()},
        )

    async def set_default_branch(self, name: str) -> None:
        """Make branch ``name`` the repository's default.

        Args:
            name (str): a branch the repository has.
        """
        await self.run.call("PATCH", self.api, json={"default_branch": name})

    async def _commit_entries(
        self, entries: list[dict[str, Any]], branch: str = "main"
    ) -> str:
        head = await self.head(branch)
        tree = await self.run.call(
            "POST",
            f"{self.api}/git/trees",
            json={"tree": entries, "base_tree": head},
        )
        made = await self.run.call(
            "POST",
            f"{self.api}/git/commits",
            json={"message": "change", "tree": tree["sha"], "parents": [head]},
        )
        await self.run.call(
            "PATCH",
            f"{self.api}/git/refs/heads/{branch}",
            json={"sha": made["sha"]},
        )
        return str(made["sha"])

    async def replace(self, files: dict[str, bytes]) -> str:
        """Commit ``main`` to hold exactly ``files`` and return the new head.

        Args:
            files (dict[str, bytes]): repo-relative path to bytes.
        """
        gone: dict[str, bytes | None] = {
            path: None for path in await self.paths() if path not in files
        }
        return await self.commit({**gone, **files})

    async def truncate(self) -> None:
        """Answer the recursive tree truncated from now on, top-level rows
        only, as git cuts a tree past its entry cap.

        The run is reloaded, so the request list starts afresh."""
        await self.run.execute(
            "UPDATE GithubRepo SET truncated = 1 WHERE fullName = ?",
            f"{self.owner}/{self.name}",
        )
        await self.run.record_requests()

    async def tree(self, segment: str, recursive: bool = False) -> Any:
        """What GitHub answers for the tree ``segment`` names.

        Args:
            segment (str): a ref, a sha or ``{rev}:{dir}``, unquoted.
            recursive (bool): every row beneath it.
        """
        query = "?recursive=1" if recursive else ""
        return await self.run.call(
            "GET", f"{self.api}/git/trees/{quote(segment, safe='')}{query}"
        )

    async def cut_short(self, folder: str, keep: int) -> None:
        """Answer the shallow listing of ``folder``, asked by its sha or as
        ``main:{folder}``, cut to its first ``keep`` rows and marked
        truncated, until cleared.

        GitHub cuts a listing past its entry cap; no directory the fake
        holds is that large, so its own answer is changed in that one way.

        Args:
            folder (str): the folder's repo-relative path.
            keep (int): how many rows the listing keeps.
        """
        listing = await self.tree(f"main:{folder}")
        cut = {**listing, "tree": listing["tree"][:keep], "truncated": True}
        for segment in (listing["sha"], f"main:{folder}"):
            await self.run.answer_next(
                "GET",
                TREES,
                200,
                cut,
                times=UNTIL_CLEARED,
                path=self.tree_path(segment),
                query="",
            )

    def search_query(self, q: str) -> str:
        """The query string a code search for ``q`` arrives with, as
        Mirage's client sends it: ``q`` then the largest page.

        Args:
            q (str): the whole query, qualifiers included.
        """
        asked = URL("http://h/search/code").with_query(
            {"q": q, "per_page": "100"}
        )
        return asked.raw_query_string

    def tree_path(self, segment: str) -> str:
        """The path a tree request for ``segment`` arrives at, as Mirage's
        client sends it: the segment quoted whole, which yarl then writes
        back with a plain ``:`` and a ``%2F`` kept.

        Args:
            segment (str): a ref, a sha or ``{rev}:{dir}``, unquoted.
        """
        quoted = quote(segment, safe="")
        return URL(f"http://h{self.api}/git/trees/{quoted}").raw_path

    async def refuse(
        self,
        name: str,
        status: int,
        message: str,
        times: int = UNTIL_CLEARED,
    ) -> None:
        """Answer the requests :meth:`log` names ``name`` with ``status``.

        Args:
            name (str): ``dir``, ``recursive``, ``blob``, ``repo`` or
                ``search``.
            status (int): the status to answer.
            message (str): the message GitHub's error body carries.
            times (int): how many requests it answers; every one until
                ``run.clear_answers`` by default.
        """
        method, route, query = NAMED[name]
        await self.run.answer_next(
            method,
            route,
            status,
            {"message": message},
            times=times,
            query=query,
        )

    async def answer(self, name: str, body: Any, times: int = 1) -> None:
        """Answer the next ``times`` requests :meth:`log` names ``name``
        with a 200 carrying ``body``, for an answer the fake never gives.

        Args:
            name (str): ``dir``, ``recursive``, ``blob``, ``repo`` or
                ``search``.
            body (Any): the JSON body.
            times (int): how many requests it answers.
        """
        method, route, query = NAMED[name]
        await self.run.answer_next(
            method, route, 200, body, times=times, query=query
        )

    async def _is_commit(self, sha: str) -> bool:
        async with self.run.http.get(
            f"{self.run.url}{self.api}/git/commits/{sha}"
        ) as resp:
            await resp.read()
            return resp.status == 200

    async def log(self) -> list[tuple[str, str]]:
        """Each request made since recording started, as ``(name,
        segment)``.

        A tree is ``recursive``, ``dir`` for a ref, a commit or
        ``{rev}:{dir}``, and ``sha_dir`` for a tree by its own sha, each
        with its segment as sent. A blob is ``blob`` with its sha, a raw
        download ``raw`` with ``{commit}/{path}``, code search ``search``
        with its ``q``, GraphQL ``graphql`` with the oids it asked joined
        by commas, and the repository ``repo``; any other request is
        named by its method and route."""
        listed = await self.run.call("GET", "/_kit/requests")
        named: list[tuple[str, str]] = []
        for r in listed["requests"]:
            route, path = r["route"], r["path"]
            if route == TREES:
                segment = path.split("/git/trees/", 1)[1]
                if "recursive" in parse_qs(r["query"]):
                    name = "recursive"
                elif ":" in unquote(segment) or not SHA40.match(segment):
                    name = "dir"
                else:
                    commit = await self._is_commit(segment)
                    name = "dir" if commit else "sha_dir"
                named.append((name, segment))
            elif route == BLOBS:
                named.append(("blob", path.rsplit("/", 1)[1]))
            elif route == RAW:
                prefix = f"/raw/{self.owner}/{self.name}/"
                named.append(("raw", unquote(path.removeprefix(prefix))))
            elif route == REPO_ROUTE:
                named.append(("repo", ""))
            elif route == SEARCH:
                named.append(("search", parse_qs(r["query"])["q"][0]))
            elif route == GRAPHQL:
                asked = (r["body"] or {}).get("variables", {})
                oids = [
                    str(v)
                    for k, v in asked.items()
                    if k not in ("owner", "repo")
                ]
                named.append(("graphql", ",".join(oids)))
            else:
                named.append((f"{r['method']} {route}", path))
        return named

    async def count(self, name: str) -> int:
        """How many requests :meth:`log` names ``name``.

        Args:
            name (str): the request's name.
        """
        return sum(1 for got, _ in await self.log() if got == name)

    async def counts(self) -> tuple[int, int, int]:
        """How many ``dir``, ``recursive`` and ``blob`` requests were made."""
        names = [name for name, _ in await self.log()]
        return (
            names.count("dir"),
            names.count("recursive"),
            names.count("blob"),
        )


@pytest_asyncio.fixture
async def repo(github_origin: str) -> AsyncIterator[GitHubRepo]:
    made = GitHubRepo(github_origin)
    yield made
    await made.run.close()
