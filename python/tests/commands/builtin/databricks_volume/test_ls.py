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

from mirage import MountMode, Workspace
from tests.resource.databricks_volume.test_databricks_volume import (
    FakeFilesClient, make_resource, seed_directory, seed_file)

ROOT = "/Volumes/main/default/agent_files/root"


@pytest.fixture
def dbx_files() -> FakeFilesClient:
    files = FakeFilesClient()
    seed_directory(files, ROOT)
    seed_file(files, f"{ROOT}/words.txt", b"beta\nalpha\nalpha\n")
    seed_file(files, f"{ROOT}/.hidden", b"h\n")
    files.add_directory(f"{ROOT}/sub")
    seed_file(files, f"{ROOT}/sub/inner.txt", b"gamma\nalpha\n")
    return files


@pytest.fixture
def ws(dbx_files: FakeFilesClient) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_ls_lists_entries(ws):
    io = await ws.execute("ls /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "sub" in out
    assert ".hidden" not in out


@pytest.mark.asyncio
async def test_ls_a_includes_hidden(ws):
    io = await ws.execute("ls -a /dbx/")

    assert io.exit_code == 0
    assert ".hidden" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_long_includes_size(ws):
    io = await ws.execute("ls -l /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "17" in out


@pytest.mark.asyncio
async def test_ls_recursive_descends_subdirs(ws):
    io = await ws.execute("ls -R /dbx/")

    assert io.exit_code == 0
    assert "inner.txt" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_missing_path_warns(ws):
    io = await ws.execute("ls /dbx/missing")

    assert io.exit_code != 0
