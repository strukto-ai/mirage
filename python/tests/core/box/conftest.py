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

import aiohttp
import pytest_asyncio

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import BoxTokenManager
from mirage.vfs.box.config import BoxConfig
from tests.fixtures.kit_fake import KitRun

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

    async def entries(self, folder_id: str) -> list[dict[str, Any]]:
        """Every row a folder's listing gives, page by page.

        Args:
            folder_id (str): the folder's id.
        """
        rows: list[dict[str, Any]] = []
        while True:
            page = await self.run.call(
                "GET", f"/2.0/folders/{folder_id}/items?offset={len(rows)}"
            )
            rows.extend(page["entries"])
            if not page["entries"] or len(rows) >= page["total_count"]:
                return rows

    async def names(self, folder_id: str) -> list[str]:
        """The names a folder holds, sorted.

        Args:
            folder_id (str): the folder's id.
        """
        return sorted(entry["name"] for entry in await self.entries(folder_id))

    async def child(self, folder_id: str, name: str) -> dict[str, Any]:
        """The row a folder's listing gives ``name``.

        Args:
            folder_id (str): the folder's id.
            name (str): the child's name.
        """
        listed = await self.entries(folder_id)
        rows = [e for e in listed if e["name"] == name]
        assert len(rows) == 1, (name, listed)
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

    async def row_at(self, path: str) -> dict[str, Any] | None:
        """The listing row of the item at ``path``; None if none is there.

        Args:
            path (str): slash-separated names from All Files.
        """
        row: dict[str, Any] | None = {"id": "0", "type": "folder"}
        for name in [p for p in path.split("/") if p]:
            if row is None or row["type"] != "folder":
                return None
            found = [
                e for e in await self.entries(row["id"]) if e["name"] == name
            ]
            row = found[0] if found else None
        return row

    async def id_of(self, path: str) -> str:
        """The id of the item at ``path``.

        Args:
            path (str): slash-separated names from All Files.
        """
        row = await self.row_at(path)
        assert row is not None, path
        return row["id"]

    async def folder_at(self, path: str) -> str:
        """The id of the folder at ``path``, making those missing on the way.

        Args:
            path (str): slash-separated names from All Files.
        """
        folder = "0"
        for name in [p for p in path.split("/") if p]:
            found = [
                e
                for e in await self.entries(folder)
                if e["name"] == name and e["type"] == "folder"
            ]
            folder = (
                found[0]["id"] if found else await self.mkdir(name, folder)
            )
        return folder

    async def write(self, path: str, data: bytes) -> str:
        """Put ``data`` at ``path`` as another client would: a new version of
        the file there, else a new file. Returns its id.

        Args:
            path (str): slash-separated names from All Files.
            data (bytes): the content.
        """
        row = await self.row_at(path)
        if row is not None:
            await self.upload_version(row["id"], data)
            return row["id"]
        parent, _, name = path.strip("/").rpartition("/")
        return await self.put(name, data, await self.folder_at(parent))

    async def move(self, path: str, to: str) -> None:
        """Move or rename the file or folder at ``path`` to ``to``, as
        another client would, making the folders missing on the way. The
        fake has no route that moves a web link.

        Args:
            path (str): slash-separated names from All Files.
            to (str): where it goes, the same way.
        """
        row = await self.row_at(path)
        assert row is not None, path
        assert row["type"] in ("file", "folder"), row
        parent, _, name = to.strip("/").rpartition("/")
        kind = "folders" if row["type"] == "folder" else "files"
        await self.run.call(
            "PUT",
            f"/2.0/{kind}/{row['id']}",
            json={
                "name": name,
                "parent": {"id": await self.folder_at(parent)},
            },
        )

    async def remove(self, path: str) -> None:
        """Delete the item at ``path``, a folder with everything in it.

        Args:
            path (str): slash-separated names from All Files.
        """
        row = await self.row_at(path)
        assert row is not None, path
        kind = {"file": "files", "folder": "folders", "web_link": "web_links"}
        query = "?recursive=true" if row["type"] == "folder" else ""
        await self.run.call(
            "DELETE", f"/2.0/{kind[row['type']]}/{row['id']}{query}"
        )

    async def content(self, path: str) -> bytes | None:
        """The bytes of the file at ``path``; None if no file is there.

        Args:
            path (str): slash-separated names from All Files.
        """
        row = await self.row_at(path)
        if row is None or row["type"] != "file":
            return None
        return await self.read(row["id"])

    async def unhash(self, file_id: str) -> None:
        """Store the file ``file_id`` with no sha1, as Box answers some.

        Its new versions keep none either. The run is reloaded, so a
        recording of its requests stops.

        Args:
            file_id (str): the file's id.
        """
        await self.run.execute(
            "UPDATE BoxItem SET sha1 = NULL WHERE id = ?", file_id
        )

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


@pytest_asyncio.fixture
async def account(box_origin: str) -> AsyncIterator[BoxAccount]:
    made = BoxAccount(box_origin)
    yield made
    await made.run.close()
