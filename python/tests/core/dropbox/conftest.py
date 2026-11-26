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
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.vfs.dropbox.config import DropboxConfig
from tests.fixtures.kit_fake import KitRun

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
        page = await self.run.call(
            "POST", "/2/files/list_folder", json={"path": path}
        )
        names = [entry["name"] for entry in page["entries"]]
        while page["has_more"]:
            page = await self.run.call(
                "POST",
                "/2/files/list_folder/continue",
                json={"cursor": page["cursor"]},
            )
            names.extend(entry["name"] for entry in page["entries"])
        return sorted(names)

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

    async def content(self, path: str) -> bytes | None:
        """The bytes of the file at ``path``; None if no file is there.

        Args:
            path (str): the file's path.
        """
        async with self.run.http.post(
            self.run.url + "/2/files/download",
            headers={"Dropbox-API-Arg": json.dumps({"path": path})},
        ) as resp:
            body = await resp.read()
            if resp.status == 409:
                return None
            assert resp.status == 200, body
            return body

    async def remove(self, path: str) -> None:
        """Delete the file or folder at ``path``, as another client would.

        Args:
            path (str): the item's path.
        """
        await self.run.call("POST", "/2/files/delete_v2", json={"path": path})


@pytest_asyncio.fixture
async def account(dropbox_origin: str) -> AsyncIterator[DropboxAccount]:
    made = DropboxAccount(dropbox_origin)
    yield made
    await made.run.close()


@pytest.fixture
def dropbox_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))
