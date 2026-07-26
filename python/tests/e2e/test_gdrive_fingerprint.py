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

import pytest

from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.types import ConsistencyPolicy, MountMode
from mirage.workspace import Workspace
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive


@pytest.mark.asyncio
async def test_gdrive_always_refetches_after_external_mutation():
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    resource = GoogleDriveResource(config)
    ws = Workspace(
        {"/gd": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )
    with patch_gdrive(fake):
        await ws.execute("ls /gd")
        io1 = await ws.execute("cat /gd/file.txt")
        assert (await io1.materialize_stdout()) == b"v1"

        fake.add_file("file.txt", b"v2-external")
        await ws.execute("ls /gd")

        io2 = await ws.execute("cat /gd/file.txt")
        assert (await io2.materialize_stdout()) == b"v2-external", (
            "GDrive ALWAYS must refetch after modifiedTime changes")


@pytest.mark.asyncio
async def test_gdrive_lazy_may_serve_stale():
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    resource = GoogleDriveResource(config)
    ws = Workspace(
        {"/gd": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.LAZY,
    )
    with patch_gdrive(fake):
        await ws.execute("ls /gd")
        io1 = await ws.execute("cat /gd/file.txt")
        assert (await io1.materialize_stdout()) == b"v1"

        fake.add_file("file.txt", b"v2-external")

        io2 = await ws.execute("cat /gd/file.txt")
        got = await io2.materialize_stdout()
        assert got in (b"v1", b"v2-external"), (
            "LAZY allowed to serve cache; just confirming no crash")
