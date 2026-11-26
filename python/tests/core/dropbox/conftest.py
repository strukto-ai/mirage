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
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
import pytest_asyncio

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.vfs.dropbox.config import DropboxConfig
from tests.fixtures.kit_fake import KitRun, serve

TOKEN = "unit"


class DropboxAccount:
    """One Dropbox account on the fake, and the writes a test arranges it by.

    The fake answers a refresh with the refresh token as the access token,
    so the accessor's calls land on the same account as ``run``'s.

    Args:
        origin (str): the Dropbox fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})

    def accessor(self, root_path: str = "/") -> DropboxAccessor:
        """A Mirage accessor on this account.

        Args:
            root_path (str): the folder the mount is rooted at.
        """
        config = DropboxConfig(
            client_id="c",
            client_secret="s",
            refresh_token=TOKEN,
            endpoint=self.run.url,
            root_path=root_path,
        )
        return DropboxAccessor(config, DropboxTokenManager(config))

    async def put(self, path: str, data: bytes) -> dict[str, Any]:
        """Upload ``data`` at ``path``, replacing a file there, and return
        its metadata.

        Args:
            path (str): the file's path.
            data (bytes): its content.
        """
        arg = {"path": path, "mode": "overwrite"}
        return await self.run.call(
            "POST",
            "/2/files/upload",
            data=data,
            headers={
                "Dropbox-API-Arg": json.dumps(arg),
                "Content-Type": "application/octet-stream",
            },
        )

    async def mkdir(self, path: str) -> dict[str, Any]:
        """Create a folder and return its metadata.

        Args:
            path (str): the folder's path.
        """
        made = await self.run.call(
            "POST", "/2/files/create_folder_v2", json={"path": path}
        )
        return made["metadata"]

    async def metadata(self, path: str) -> dict[str, Any]:
        """What Dropbox answers for ``path``.

        Args:
            path (str): the item's path.
        """
        return await self.run.call(
            "POST", "/2/files/get_metadata", json={"path": path}
        )

    async def names(self, path: str = "") -> list[str]:
        """The names a folder holds, sorted.

        Args:
            path (str): the folder's path; empty for the account root.
        """
        listed = await self.run.call(
            "POST", "/2/files/list_folder", json={"path": path}
        )
        return sorted(entry["name"] for entry in listed["entries"])

    async def read(self, path: str) -> bytes:
        """A file's content, downloaded as a client would.

        Args:
            path (str): the file's path.
        """
        return await self.run.read(
            "/2/files/download",
            "POST",
            headers={"Dropbox-API-Arg": json.dumps({"path": path})},
        )


class FakeDropboxRpc:
    """A ``dropbox_rpc`` stand-in that pages ``/files/list_folder``.

    Stands in for the transport rather than for ``list_folder`` itself,
    because the walk is what a probe has to bound and only the real
    ``list_folder`` performs it: a stub in its place answers in one call
    whatever the caller asked for, so it cannot tell a bounded probe from
    an unbounded one.

    Pages every request on the limit the first one carried, as the real
    API does (the cursor retains the original request's parameters), and
    records both the cap each caller asked for and how many requests the
    walk actually made. ``page_size`` cannot express a bound on the walk:
    it caps the page, not the walk, so a small page turns a listing of a
    large folder into more requests rather than fewer.

    Args:
        entries (list[dict] | None): the folder's listing.
        metadata (dict | None): what ``/files/get_metadata`` answers.
        move_errors (list[DropboxApiError | None] | None): one entry per
            ``/files/move_v2`` call; a ``DropboxApiError`` is raised.
    """

    def __init__(
        self,
        entries: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
        move_errors: list[DropboxApiError | None] | None = None,
    ) -> None:
        self.entries = list(entries or [])
        self.metadata = metadata
        self.metadata_paths: list[str] = []
        self.move_errors = list(move_errors or [])
        # Every `limit` a caller asked for, so a test can pin that an
        # emptiness probe is bounded, and the request count, which is the
        # half an unbounded walk gets wrong.
        self.list_limits: list[int] = []
        self.list_requests = 0
        self.deleted: list[str] = []
        self.moves: list[tuple[str, str]] = []
        self._cursors: dict[str, list[dict[str, Any]]] = {}
        self._limits: dict[str, int] = {}

    def _page(self, rest: list[dict[str, Any]], limit: int) -> dict[str, Any]:
        self.list_requests += 1
        head, tail = rest[:limit], rest[limit:]
        token = f"cursor-{len(self._cursors)}"
        self._cursors[token] = tail
        self._limits[token] = limit
        return {"entries": head, "cursor": token, "has_more": bool(tail)}

    async def __call__(
        self, tm: DropboxTokenManager, endpoint: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        if endpoint == "/files/list_folder":
            limit = int(body.get("limit") or 2000)
            self.list_limits.append(limit)
            self._cursors = {}
            self._limits = {}
            return self._page(self.entries, limit)
        if endpoint == "/files/list_folder/continue":
            token = body["cursor"]
            return self._page(self._cursors.pop(token), self._limits[token])
        if endpoint == "/files/get_metadata":
            self.metadata_paths.append(body["path"])
            if self.metadata is None:
                raise DropboxApiError("nf", 409, "path/not_found/...")
            return self.metadata
        if endpoint == "/files/delete_v2":
            self.deleted.append(body["path"])
            return {}
        if endpoint == "/files/move_v2":
            self.moves.append((body["from_path"], body["to_path"]))
            error = self.move_errors.pop(0) if self.move_errors else None
            if error is not None:
                raise error
            return {}
        raise AssertionError(f"unexpected endpoint {endpoint}")


@pytest.fixture(scope="session")
def dropbox_origin() -> Iterator[str]:
    with serve("dropbox") as origin:
        yield origin


@pytest_asyncio.fixture
async def account(dropbox_origin: str) -> AsyncIterator[DropboxAccount]:
    made = DropboxAccount(dropbox_origin)
    yield made
    await made.run.close()


@pytest.fixture
def dropbox_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))
