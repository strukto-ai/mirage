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

import re
import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import quote, unquote

import pytest_asyncio

from tests.fixtures.kit_fake import KitRun

# The drive /me/drive names on the fake, and the one SharePoint mounts
# declare and name.
ONEDRIVE = "default"
SITE_NAME = "Main"
DRIVE_NAME = "Documents"
DOWNLOAD = "/download/:tenant/:drive/*path"
ME_DRIVE = "/me/drive/*rest"
DRIVES = "/drives/:drive/*rest"
SITES = "/sites"
SITE_DRIVES = "/sites/:site/drives"
# What a read or stat asks for; any other request it sends is reported.
READS = {
    "item",
    "children",
    "content",
    "version_content",
    "download",
    "sites",
    "drives",
}


class GraphDrive:
    """One drive on the integ Microsoft Graph (OneDrive) fake, and the writes
    a test arranges it by.

    The fake keeps one account per access token, so each drive sends a
    token of its own; ``drive`` is ``default`` for a OneDrive mount
    (``/me/drive``) or a SharePoint document library the drive declares.

    Args:
        origin (str): the fake's origin.
        drive (str): the drive's id, which is its name on the fake.
    """

    def __init__(self, origin: str, drive: str = ONEDRIVE) -> None:
        self.token = uuid.uuid4().hex
        self.drive = drive
        self.run = KitRun(origin, {"Authorization": f"Bearer {self.token}"})
        self.prefix = (
            "/me/drive"
            if drive == ONEDRIVE
            else f"/drives/{quote(drive, safe='')}"
        )

    async def reset(self) -> None:
        """Start the account afresh, its drive declared."""
        await self.run.call("POST", "/reset", json={"tenants": [self.token]})
        if self.drive != ONEDRIVE:
            await self.run.call("PUT", f"/drives/{quote(self.drive, safe='')}")

    def config(self, provider: str, **fields: Any) -> dict[str, Any]:
        """A mount config for ``provider`` (onedrive or sharepoint) on the
        drive; a SharePoint one is scoped to its site and library.

        Args:
            provider (str): ``onedrive`` or ``sharepoint``.
            **fields (Any): config fields to set or replace.
        """
        given: dict[str, Any] = {
            "access_token": self.token,
            "graph_base_url": self.run.url,
        }
        if provider == "sharepoint":
            given |= {"site": SITE_NAME, "drive": self.drive}
        return {**given, **fields}

    def _item(self, path: str) -> str:
        return f"{self.prefix}/root:/{quote(path)}"

    async def write(self, path: str, data: bytes) -> None:
        """Write a file's content as another client would, minting a new
        cTag, eTag and version.

        Args:
            path (str): its path in the drive.
            data (bytes): what it holds.
        """
        await self.run.call("PUT", f"{self._item(path)}:/content", data=data)

    async def remove(self, path: str) -> None:
        """Delete an item as another client would.

        Args:
            path (str): its path in the drive.
        """
        async with self.run.http.delete(
            f"{self.run.url}{self._item(path)}"
        ) as resp:
            assert resp.status < 300, await resp.text()

    async def touch(self, path: str) -> None:
        """Edit a file's metadata as a rename or a property edit does:
        the eTag and the stamp move, the cTag and the bytes stay. The fake
        has no route for a bare property edit, so the row changes directly.

        The change reloads the run, which stops a recording, so the
        recording starts again here: :meth:`log` lists the requests made
        since the edit.

        Args:
            path (str): its path in the drive.
        """
        await self.run.execute(
            "UPDATE GraphFile SET etag = etag || '-edited', "
            "modified = '2027-01-01T00:00:00Z' "
            "WHERE tenant = ? AND drive = ? AND path = ?",
            self.token,
            self.drive,
            path,
        )
        await self.run.record_requests()

    async def content(self, path: str) -> bytes:
        """What a file holds now.

        Args:
            path (str): its path in the drive.
        """
        return await self.run.read(f"{self._item(path)}:/content")

    async def write_after_the_bytes(self, path: str, new: bytes) -> None:
        """Change a file the moment its next download has taken its bytes:
        the download answers what the file held, while Graph already holds
        ``new``. The download waits while another client writes ``new``,
        then answers the bytes it had before.

        Args:
            path (str): its path in the drive.
            new (bytes): what the file holds once the bytes are taken.
        """
        old = await self.content(path)

        async def change() -> None:
            await self.write(path, new)
            await self.run.answer_next("GET", DOWNLOAD, 200, old)

        await self.run.before_next([("GET", DOWNLOAD)], change)

    async def item(self, path: str) -> dict[str, Any]:
        """The item Graph answers for a path.

        Args:
            path (str): its path in the drive.
        """
        made: dict[str, Any] = await self.run.call("GET", self._item(path))
        return made

    async def ctag(self, path: str) -> str:
        """The cTag the item holds now.

        Args:
            path (str): its path in the drive.
        """
        return str((await self.item(path))["cTag"])

    async def _listed(self) -> list[dict[str, Any]]:
        listed = await self.run.call("GET", "/_kit/requests")
        requests: list[dict[str, Any]] = listed["requests"]
        return requests

    async def log(self) -> list[tuple[str, str, str]]:
        """Each request since recording started, as ``(name, path,
        query)``: ``item``, ``children``, ``content``, ``version_content``,
        ``download``, ``upload``, ``delta``, ``sites`` and ``drives``, the
        path the one it names in the drive."""
        out: list[tuple[str, str, str]] = []
        for r in await self._listed():
            # A minted URL names its tenant for the kit; Graph's own query is
            # the rest.
            query = unquote(re.sub(r"(^|&)_tenant=[^&]*", "", r["query"]))
            query = query.lstrip("&")
            if r["route"] == DOWNLOAD:
                path = unquote(r["path"]).split("/", 4)[4]
                out.append(("download", path, query))
            elif r["route"] == SITES:
                out.append(("sites", "", query))
            elif r["route"] == SITE_DRIVES:
                out.append(("drives", r["path"].split("/")[2], query))
            elif r["route"] in (ME_DRIVE, DRIVES):
                out.append(
                    _drive_request(r["method"], unquote(r["path"]), query)
                )
            else:
                out.append((f"{r['method']} {r['route']}", r["path"], query))
        return out

    async def count(self, name: str) -> int:
        """How many requests of one name since recording started.

        Args:
            name (str): the name :meth:`log` gives it.
        """
        return sum(1 for logged, _, _ in await self.log() if logged == name)

    async def fetches(self) -> int:
        """How many requests fetched bytes since recording started."""
        names = ("download", "content", "version_content")
        return sum(1 for logged, _, _ in await self.log() if logged in names)

    async def reach(self, children_allowed: int = 0) -> list[str]:
        """The requests no read or stat should make, since recording
        started: a second sites or drives lookup, a children listing past
        the ``children_allowed`` a test's own ``ls`` makes, and any request
        a read does not make, an upload, a delete or a delta read among
        them.

        Args:
            children_allowed (int): children listings not counted.
        """
        log = await self.log()
        out: list[str] = []
        if sum(1 for name, _, _ in log if name == "sites") > 1:
            out.append("sites listed twice")
        if sum(1 for name, _, _ in log if name == "drives") > 1:
            out.append("drives listed twice")
        children = [path for name, path, _ in log if name == "children"]
        out += [
            f"children of {path or '/'}"
            for path in children[children_allowed:]
        ]
        out += [f"{name} {path}" for name, path, _ in log if name not in READS]
        return out

    async def queries(self, name: str) -> list[str]:
        """The query of each request of one name, in order.

        Args:
            name (str): the name :meth:`log` gives it.
        """
        return [
            query for logged, _, query in await self.log() if logged == name
        ]


def _drive_request(method: str, path: str, query: str) -> tuple[str, str, str]:
    """Name a request to a drive's own routes as the tests read them.

    Args:
        method (str): the HTTP method.
        path (str): the request path, ``/me/drive/...`` or
            ``/drives/{id}/...``.
        query (str): its query string.
    """
    rest = (
        path.split("/", 3)[3]
        if path.startswith("/drives/")
        else path[len("/me/drive/") :]
    )
    if rest == "root/delta":
        return ("delta", "", query)
    if rest.startswith("items/"):
        return ("item_by_id", rest, query)
    if rest == "root":
        return ("item", "", query)
    if rest == "root/children":
        return ("children", "", query)
    item, _, action = rest[len("root:/") :].partition(":")
    if action == "":
        return ("item" if method == "GET" else method, item, query)
    if action == "/children":
        return ("children", item, query)
    if action == "/content":
        return ("upload" if method == "PUT" else "content", item, query)
    if action.startswith("/versions/") and action.endswith("/content"):
        return ("version_content", item, query)
    return (f"{method} {action}", item, query)


@pytest_asyncio.fixture
async def onedrive(graph_origin: str) -> AsyncIterator[GraphDrive]:
    """A OneDrive of its own on the Graph fake, its requests recorded from
    here.

    Args:
        graph_origin (str): the fake's origin.
    """
    made = GraphDrive(graph_origin)
    await made.reset()
    await made.run.record_requests()
    yield made
    await made.run.close()


@pytest_asyncio.fixture
async def sharepoint(graph_origin: str) -> AsyncIterator[GraphDrive]:
    """A SharePoint document library of its own on the Graph fake, its
    requests recorded from here.

    Args:
        graph_origin (str): the fake's origin.
    """
    made = GraphDrive(graph_origin, DRIVE_NAME)
    await made.reset()
    await made.run.record_requests()
    yield made
    await made.run.close()
