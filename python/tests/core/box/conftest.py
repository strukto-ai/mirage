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

import aiohttp
import pytest
import pytest_asyncio

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import BoxTokenManager
from mirage.vfs.box.config import BoxConfig
from tests.fixtures.kit_fake import KitRun, serve

TOKEN = "unit"


class BoxAccount:
    """One Box account on the fake, and the writes a test arranges it by.

    Args:
        origin (str): the Box fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})

    def accessor(self, root_folder_id: str | None = None) -> BoxAccessor:
        """A Mirage accessor on this account.

        Args:
            root_folder_id (str | None): the folder the mount is rooted at.
        """
        config = BoxConfig(
            access_token=TOKEN,
            endpoint=self.run.url,
            root_folder_id=root_folder_id,
        )
        return BoxAccessor(config, BoxTokenManager(config))

    async def mkdir(self, name: str, parent: str = "0") -> str:
        """Create a folder and return its id.

        Args:
            name (str): the folder's name.
            parent (str): the id of the folder it goes in.
        """
        made = await self.run.call(
            "POST",
            "/2.0/folders",
            json={"name": name, "parent": {"id": parent}},
        )
        return made["id"]

    async def put(self, name: str, data: bytes, parent: str = "0") -> str:
        """Upload a new file and return its id.

        Args:
            name (str): the file's name.
            data (bytes): its content.
            parent (str): the id of the folder it goes in.
        """
        form = aiohttp.FormData()
        form.add_field(
            "attributes", json.dumps({"name": name, "parent": {"id": parent}})
        )
        form.add_field("file", data, filename=name)
        made = await self.run.call("POST", "/2.0/files/content", data=form)
        return made["entries"][0]["id"]

    async def upload_version(self, file_id: str, data: bytes) -> None:
        """Upload a new version of a file, as another client would.

        Args:
            file_id (str): the file's id.
            data (bytes): its new content.
        """
        form = aiohttp.FormData()
        form.add_field("attributes", json.dumps({}))
        form.add_field("file", data, filename="version")
        await self.run.call("POST", f"/2.0/files/{file_id}/content", data=form)

    async def rename(self, file_id: str, name: str) -> None:
        """Rename a file in place, as another client would.

        Args:
            file_id (str): the file's id.
            name (str): its new name.
        """
        await self.run.call(
            "PUT", f"/2.0/files/{file_id}", json={"name": name}
        )

    async def names(self, folder_id: str) -> list[str]:
        """The names a folder holds, sorted.

        Args:
            folder_id (str): the folder's id.
        """
        listed = await self.run.call("GET", f"/2.0/folders/{folder_id}/items")
        return sorted(entry["name"] for entry in listed["entries"])

    async def child(self, folder_id: str, name: str) -> dict[str, Any]:
        """The row a folder's listing gives ``name``.

        Args:
            folder_id (str): the folder's id.
            name (str): the child's name.
        """
        listed = await self.run.call("GET", f"/2.0/folders/{folder_id}/items")
        rows = [e for e in listed["entries"] if e["name"] == name]
        assert len(rows) == 1, (name, listed["entries"])
        return rows[0]

    async def read(self, file_id: str) -> bytes:
        """A file's content, downloaded as a client would.

        Args:
            file_id (str): the file's id.
        """
        return await self.run.read(f"/2.0/files/{file_id}/content")

    async def web_link(self, name: str, parent: str = "0") -> str:
        """Create a web link and return its id.

        Args:
            name (str): the link's name.
            parent (str): the id of the folder it goes in.
        """
        made = await self.run.call(
            "POST",
            "/2.0/web_links",
            json={
                "url": "https://example.com",
                "name": name,
                "parent": {"id": parent},
            },
        )
        return made["id"]

    async def file_info(self, file_id: str) -> dict[str, Any]:
        """What Box answers for a file by id.

        Args:
            file_id (str): the file's id.
        """
        return await self.run.call("GET", f"/2.0/files/{file_id}")

    async def folder_info(self, folder_id: str) -> dict[str, Any]:
        """What Box answers for a folder by id.

        Args:
            folder_id (str): the folder's id.
        """
        return await self.run.call("GET", f"/2.0/folders/{folder_id}")


@pytest.fixture(scope="session")
def box_origin() -> Iterator[str]:
    with serve("box") as origin:
        yield origin


@pytest_asyncio.fixture
async def account(box_origin: str) -> AsyncIterator[BoxAccount]:
    made = BoxAccount(box_origin)
    yield made
    await made.run.close()
