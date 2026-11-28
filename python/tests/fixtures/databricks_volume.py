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

import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import quote, unquote

import pytest_asyncio

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.vfs.databricks_volume import DatabricksVolumeConfig
from tests.fixtures.kit_fake import KitRun, run_token

ROOT = "/Volumes/main/default/agent_files/root"
FILES = "/api/2.0/fs/files/*tail"
DIRS = "/api/2.0/fs/directories/*tail"
FILES_PREFIX = "/api/2.0/fs/files"
DIRS_PREFIX = "/api/2.0/fs/directories"
EPOCH = "2023-11-14T22:13:20Z"
TENANT = "volume"


class DatabricksVolume:
    """One Unity Catalog volume on the integ Databricks fake, and the writes
    a test arranges it by.

    A mount's host is a bare origin, so it cannot carry a run's path; the
    access token names the run instead (``run_token``).

    Args:
        origin (str): the Databricks fake's origin.
    """

    def __init__(self, origin: str) -> None:
        name = uuid.uuid4().hex
        self.token = run_token(name, TENANT)
        self.origin = origin
        self.run = KitRun(
            origin, {"Authorization": f"Bearer {self.token}"}, name
        )

    def config(self, **fields: Any) -> DatabricksVolumeConfig:
        """A mount config for the volume, rooted at ``root`` unless
        ``fields`` say otherwise.

        Args:
            **fields (Any): config fields to set or replace.
        """
        given: dict[str, Any] = {
            "catalog": "main",
            "schema": "default",
            "volume": "agent_files",
            "root_path": "/root",
            "host": self.origin,
            "token": self.token,
        }
        return DatabricksVolumeConfig(**{**given, **fields})

    def accessor(self, **fields: Any) -> DatabricksVolumeAccessor:
        """A Mirage accessor on the volume.

        Args:
            **fields (Any): config fields to set or replace.
        """
        return DatabricksVolumeAccessor(self.config(**fields))

    async def put(self, path: str, data: bytes) -> None:
        """Write a file, its directories made on the way, as Databricks'
        Files API does.

        Args:
            path (str): the file's volume path, ``/Volumes/...``.
            data (bytes): what it holds.
        """
        await self.run.call(
            "PUT",
            f"{FILES_PREFIX}{quote(path)}",
            params={"overwrite": "true"},
            data=data,
        )

    async def mkdir(self, path: str) -> None:
        """Make a directory and those above it.

        Args:
            path (str): its volume path.
        """
        await self.run.call("PUT", f"{DIRS_PREFIX}{quote(path)}")

    async def rmdir(self, path: str) -> None:
        """Remove an empty directory.

        Args:
            path (str): its volume path.
        """
        await self.run.call("DELETE", f"{DIRS_PREFIX}{quote(path)}")

    async def set_modified(self, path: str, ms: int) -> None:
        """Mark a file last written ``ms`` milliseconds after the epoch, a
        state no request makes: the Files API stamps each write with now.

        The run is loaded back afterwards, so a recording of its requests
        starts after this.

        Args:
            path (str): its volume path.
            ms (int): when it was last written.
        """
        await self.run.execute(
            "UPDATE DatabricksNode SET lastModified = ? "
            "WHERE tenant = ? AND path = ?",
            ms,
            TENANT,
            path,
        )

    async def content(self, path: str) -> bytes:
        """What a file holds now.

        Args:
            path (str): its volume path.
        """
        return await self.run.read(f"{FILES_PREFIX}{quote(path)}")

    async def modified(self, path: str) -> str:
        """The ``Last-Modified`` header Databricks answers a file's HEAD
        with, an HTTP date to the second.

        Args:
            path (str): its volume path.
        """
        async with self.run.http.head(
            f"{self.run.url}{FILES_PREFIX}{quote(path)}"
        ) as resp:
            assert resp.status == 200, resp.status
            return resp.headers["Last-Modified"]

    async def listing(self, path: str) -> dict[str, Any]:
        """What Databricks answers for a listing of a directory.

        Args:
            path (str): its volume path.
        """
        made: dict[str, Any] = await self.run.call(
            "GET", f"{DIRS_PREFIX}{quote(path)}"
        )
        return made

    async def has(self, path: str) -> bool:
        """Whether a file or a directory is at ``path``.

        Args:
            path (str): its volume path.
        """
        for prefix in (FILES_PREFIX, DIRS_PREFIX):
            async with self.run.http.head(
                f"{self.run.url}{prefix}{quote(path)}"
            ) as resp:
                if resp.status == 200:
                    return True
        return False

    async def asked(self, method: str, route: str) -> list[str]:
        """The volume path of each listed request to ``route``, in order.

        Args:
            method (str): the HTTP method.
            route (str): ``FILES`` or ``DIRS``.
        """
        prefix = FILES_PREFIX if route == FILES else DIRS_PREFIX
        listed = await self.run.call("GET", "/_kit/requests")
        return [
            unquote(r["path"]).removeprefix(prefix)
            for r in listed["requests"]
            if r["method"] == method and r["route"] == route
        ]


@pytest_asyncio.fixture
async def volume(databricks_origin: str) -> AsyncIterator[DatabricksVolume]:
    """A volume of its own on the Databricks fake.

    Args:
        databricks_origin (str): the fake's origin.
    """
    made = DatabricksVolume(databricks_origin)
    # A fixed epoch, so a test's times are the same on every run.
    await made.run.call(
        "POST", "/reset", json={"epoch": EPOCH, "tenants": [TENANT]}
    )
    yield made
    await made.run.close()
