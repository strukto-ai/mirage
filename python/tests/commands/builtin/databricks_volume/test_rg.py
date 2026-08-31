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
    files.add_directory(f"{ROOT}/sub")
    seed_file(files, f"{ROOT}/sub/inner.txt", b"gamma\nalpha\n")
    return files


@pytest.fixture
def ws(dbx_files: FakeFilesClient) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_rg_searches_path_recursively(ws):
    io = await ws.execute("rg alpha /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "inner.txt" in out


@pytest.mark.asyncio
async def test_rg_count_only(ws):
    io = await ws.execute("rg -c alpha /dbx/words.txt")

    assert io.exit_code == 0
    assert b"2" in io.stdout


@pytest.mark.asyncio
async def test_rg_no_match_exits_nonzero(ws):
    io = await ws.execute("rg zeta /dbx/words.txt")

    assert io.exit_code != 0
