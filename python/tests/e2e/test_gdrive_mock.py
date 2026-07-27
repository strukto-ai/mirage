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
from mirage.types import MountMode
from mirage.workspace import Workspace
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive


@pytest.fixture
def gdrive_ws():
    fake = FakeGDrive()
    fake.add_file("hello.txt", b"hello world\n")
    fake.add_file("data/numbers.txt", b"one\ntwo\nthree\n")

    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    resource = GoogleDriveResource(config)
    ws = Workspace({"/gd": resource}, mode=MountMode.READ)
    with patch_gdrive(fake):
        yield ws, fake


@pytest.mark.asyncio
async def test_gdrive_mock_cat(gdrive_ws):
    ws, _ = gdrive_ws
    await ws.execute("ls /gd")
    r = await ws.execute("cat /gd/hello.txt")
    assert (await r.stdout_str()) == "hello world\n", (
        f"exit={r.exit_code} stderr={await r.stderr_str()!r}")


@pytest.mark.asyncio
async def test_gdrive_mock_ls(gdrive_ws):
    ws, _ = gdrive_ws
    r = await ws.execute("ls /gd")
    out = await r.stdout_str()
    assert "hello.txt" in out
    assert "data" in out


@pytest.mark.asyncio
async def test_gdrive_mock_grep(gdrive_ws):
    ws, _ = gdrive_ws
    await ws.execute("ls /gd")
    await ws.execute("ls /gd/data")
    r = await ws.execute("grep two /gd/data/numbers.txt")
    assert "two" in (await r.stdout_str())
