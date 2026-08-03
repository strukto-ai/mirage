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


@pytest.mark.asyncio
async def test_gdrive_mock_find_directory(gdrive_ws):
    """`find` over gdrive reaches the fake, not the real Drive API (#684).

    find resolves its start point through ``resolve_key`` and walks with
    ``iter_tree``, each of which imports ``list_files`` by value. Only
    readdir's binding was patched, so this used to 401 against the live
    API mid-test.
    """
    ws, _ = gdrive_ws
    r = await ws.execute("find /gd/data")
    assert r.exit_code == 0, f"stderr={await r.stderr_str()!r}"
    assert (await r.stdout_str()) == "/gd/data\n/gd/data/numbers.txt\n"


@pytest.mark.asyncio
async def test_gdrive_mock_find_file_start_point(gdrive_ws):
    """A file start point is reported, never walked.

    GNU findutils 4.10.0: `find <file>` prints the file and exits 0, and
    `-type f` matches it while `-type d` does not.
    """
    ws, _ = gdrive_ws
    r = await ws.execute("find /gd/hello.txt")
    assert r.exit_code == 0, f"stderr={await r.stderr_str()!r}"
    assert (await r.stdout_str()) == "/gd/hello.txt\n"
    r = await ws.execute("find /gd/hello.txt -type f")
    assert (await r.stdout_str()) == "/gd/hello.txt\n"
    r = await ws.execute("find /gd/hello.txt -type d")
    assert (await r.stdout_str()) == ""
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_gdrive_mock_find_missing_start_point(gdrive_ws):
    """A missing start point yields nothing, without reaching the network.

    GNU names it and exits 1, which mirage only does where a backend
    wires a stat cheap enough to spend on every result. gdrive does not,
    so absence stays silent here; the point of this case is that it is
    answered by the fake rather than by a live 401.
    """
    ws, _ = gdrive_ws
    r = await ws.execute("find /gd/nope")
    assert (await r.stdout_str()) == ""
    assert "401" not in (await r.stderr_str())
