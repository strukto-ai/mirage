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
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import unquote

import pytest_asyncio

from tests.fixtures.kit_fake import KitRun, run_token

TENANT = "hub"
REPO_ID = "acme/widget"
KIND = "models"
TREE = "/api/:kind/:ns/:name/tree/:rev"
TREE_UNDER = "/api/:kind/:ns/:name/tree/:rev/*path"
PATHS_INFO = "/api/:kind/:ns/:name/paths-info/:rev"
REVISION = "/api/:kind/:ns/:name/revision/:rev"
RESOLVE = "/:ns/:name/resolve/:rev/*path"
DATASET_RESOLVE = "/datasets/:ns/:name/resolve/:rev/*path"
SPACE_RESOLVE = "/spaces/:ns/:name/resolve/:rev/*path"
BRIDGE = "/xet-bridge/:hash"
UNTIL_CLEARED = 1_000_000

# What each Hub-facing request is named by in `log`.
NAMES = {
    TREE: "tree",
    TREE_UNDER: "tree",
    PATHS_INFO: "paths_info",
    REVISION: "revision",
    RESOLVE: "resolve",
    DATASET_RESOLVE: "resolve",
    SPACE_RESOLVE: "resolve",
    BRIDGE: "bridge",
}


def blob_oid(data: bytes) -> str:
    """The git blob sha of ``data``, a plain file's oid and ETag.

    Args:
        data (bytes): the content.
    """
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def lfs_oid(data: bytes) -> str:
    """The LFS sha256 of ``data``.

    Args:
        data (bytes): the content.
    """
    return hashlib.sha256(data).hexdigest()


def xet_hash(data: bytes) -> str:
    """The Xet hash a test stores ``data`` under. The fake takes no Xet
    upload, so any hash unique to the content serves.

    Args:
        data (bytes): the content.
    """
    return hashlib.sha256(b"xet:" + data).hexdigest()


def pointer_size(data: bytes) -> int:
    """The length of the git-lfs pointer that tracks ``data``.

    Args:
        data (bytes): the content.
    """
    text = (
        "version https://git-lfs.github.com/spec/v1\n"
        f"oid sha256:{lfs_oid(data)}\nsize {len(data)}\n"
    )
    return len(text)


def file_row(path: str, data: bytes, xet: bool = True) -> dict[str, Any]:
    """A tree or paths-info row for a file, as the Hub lists one.

    Args:
        path (str): the file's path in the repo.
        data (bytes): what the row describes.
        xet (bool): whether the file is stored on Xet.
    """
    row: dict[str, Any] = {
        "type": "file",
        "oid": blob_oid(data),
        "size": len(data),
        "path": path,
    }
    if xet:
        row["lfs"] = {
            "oid": lfs_oid(data),
            "size": len(data),
            "pointerSize": pointer_size(data),
        }
        row["xetHash"] = xet_hash(data)
    return row


class HubRepo:
    """One repository on the integ Hugging Face Hub fake, and the commits a
    test arranges it by.

    A mount's endpoint is a bare origin, so the access token names the run
    (``run_token``). The fake takes no Xet upload, so a file a commit stores
    on Xet is marked so in the run's rows, as the upload would leave it.

    Args:
        origin (str): the fake's origin.
        kind (str): ``models``, ``datasets`` or ``spaces``.
        repo_id (str): the repository, ``namespace/name``.
    """

    def __init__(
        self, origin: str, kind: str = KIND, repo_id: str = REPO_ID
    ) -> None:
        name = uuid.uuid4().hex
        self.origin = origin
        self.kind = kind
        self.repo_id = repo_id
        self.token = run_token(name, TENANT)
        self.run = KitRun(
            origin, {"Authorization": f"Bearer {self.token}"}, name
        )

    def config(self, **fields: Any) -> dict[str, Any]:
        """A mount config for the repository.

        Args:
            **fields (Any): config fields to set or replace.
        """
        given = {
            "repo_id": self.repo_id,
            "endpoint": self.origin,
            "token": self.token,
        }
        return {**given, **fields}

    async def create(self) -> None:
        """Make the repository, empty, as its owner would; a space is made
        with an SDK, which the Hub requires of one."""
        namespace, name = self.repo_id.split("/")
        made: dict[str, Any] = {
            "name": name,
            "organization": namespace,
            "type": self.kind.removesuffix("s"),
        }
        if self.kind == "spaces":
            made["sdk"] = "static"
        await self.run.call("POST", "/api/repos/create", json=made)

    async def commit(
        self,
        files: dict[str, bytes | None],
        xet: bool = True,
        branch: str = "main",
    ) -> str:
        """Commit ``files`` as another client would, and the new head sha.

        A path whose content is None is deleted. Marking a file as stored on
        Xet reloads the run, which stops a recording, so the recording
        starts again here.

        Args:
            files (dict[str, bytes | None]): path to its new content.
            xet (bool): store each written file on Xet.
            branch (str): the branch the commit lands on.
        """
        lines = [{"key": "header", "value": {"summary": "test commit"}}]
        for path, data in files.items():
            if data is None:
                lines.append({"key": "deletedFile", "value": {"path": path}})
                continue
            lines.append(
                {
                    "key": "file",
                    "value": {
                        "path": path,
                        "encoding": "base64",
                        "content": base64.b64encode(data).decode(),
                    },
                }
            )
        made = await self.run.call(
            "POST",
            f"/api/{self.kind}/{self.repo_id}/commit/{branch}",
            data="\n".join(json.dumps(line) for line in lines),
            headers={"Content-Type": "application/x-ndjson"},
        )
        sha = str(made["commitOid"])
        written = {p: d for p, d in files.items() if d is not None}
        if xet and written:
            for path, data in written.items():
                await self.run.execute(
                    "UPDATE HfBlob SET lfsOid = ?, pointerSize = ?, "
                    "xetHash = ? WHERE tenant = ? AND repo = ? AND sha = ? "
                    "AND path = ?",
                    lfs_oid(data),
                    pointer_size(data),
                    xet_hash(data),
                    TENANT,
                    f"{self.kind}/{self.repo_id}",
                    sha,
                    path,
                )
            await self.run.record_requests()
        return sha

    async def branch(self, name: str, sha: str) -> None:
        """Point a new branch ``name`` at ``sha``. The fake has no branch
        route, so the ref is stored directly; this reloads the run, which
        stops a recording, so the recording starts again here.

        Args:
            name (str): the branch.
            sha (str): the commit it points at.
        """
        await self.run.execute(
            "INSERT INTO HfRef (tenant, repo, refType, name, sha) "
            "VALUES (?, ?, 'branch', ?, ?)",
            TENANT,
            f"{self.kind}/{self.repo_id}",
            name,
            sha,
        )
        await self.run.record_requests()

    async def head(self, revision: str = "main") -> str:
        """The commit sha a revision names now.

        Args:
            revision (str): a branch, tag or sha.
        """
        made = await self.run.call(
            "GET", f"/api/{self.kind}/{self.repo_id}/revision/{revision}"
        )
        return str(made["sha"])

    async def refuse(
        self,
        name: str,
        status: int,
        code: str = "",
        times: int = UNTIL_CLEARED,
    ) -> None:
        """Answer the next ``times`` requests ``log`` names ``name`` with the
        Hub's error for ``status``.

        Args:
            name (str): ``tree``, ``paths_info``, ``revision`` or
                ``resolve``.
            status (int): the status to answer.
            code (str): the ``X-Error-Code`` the Hub names it by, "" for
                none.
            times (int): how many requests it answers.
        """
        method = "POST" if name == "paths_info" else "GET"
        message = f"fake {name} refused"
        headers = {"X-Error-Message": message}
        if code:
            headers["X-Error-Code"] = code
        for route, named in NAMES.items():
            if named == name:
                await self.run.answer_next(
                    method,
                    route,
                    status,
                    {"error": message},
                    times,
                    headers=headers,
                )

    async def log(self) -> list[tuple[str, str, str, str]]:
        """Each Hub-facing request since recording started, as ``(name,
        path, revision, query)``: ``tree``, ``paths_info``, ``revision``,
        ``resolve`` and ``bridge``; a paths-info request's path is its
        body."""
        listed = await self.run.call("GET", "/_kit/requests")
        out: list[tuple[str, str, str, str]] = []
        for r in listed["requests"]:
            name = NAMES.get(r["route"])
            if name is None:
                out.append((f"{r['method']} {r['route']}", r["path"], "", ""))
                continue
            path = unquote(r["path"])
            rev = ""
            rest = ""
            if name in ("tree", "paths_info", "revision"):
                after = path.split(f"/{name.replace('_', '-')}/", 1)[1]
                rev, _, rest = after.partition("/")
            elif name == "resolve":
                after = path.split("/resolve/", 1)[1]
                rev, _, rest = after.partition("/")
            if name == "paths_info":
                rest = json.dumps(r["body"])
            out.append((name, rest, rev, r["query"]))
        return out

    async def count(self, name: str) -> int:
        """How many requests ``log`` names ``name`` since recording started.

        Args:
            name (str): the name.
        """
        return sum(1 for logged, *_ in await self.log() if logged == name)


async def made_repo(origin: str, kind: str = KIND) -> HubRepo:
    """A repository of its own on the Hub fake, made empty on the running
    loop, which its session belongs to.

    Args:
        origin (str): the fake's origin.
        kind (str): ``models``, ``datasets`` or ``spaces``.
    """
    made = HubRepo(origin, kind)
    await made.run.call("POST", "/reset", json={"tenants": [TENANT]})
    await made.create()
    return made


@pytest_asyncio.fixture
async def hub(hub_origin: str) -> AsyncIterator[HubRepo]:
    """A model repository of its own on the Hub fake, made empty.

    Args:
        hub_origin (str): the fake's origin.
    """
    made = await made_repo(hub_origin)
    yield made
    await made.run.close()
