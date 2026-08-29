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
    seed_file(files, f"{ROOT}/notes.md", b"note\n")
    files.add_directory(f"{ROOT}/sub")
    seed_file(files, f"{ROOT}/sub/inner.txt", b"gamma\nalpha\n")
    return files


@pytest.fixture
def ws(dbx_files: FakeFilesClient) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_find_name_glob(ws):
    io = await ws.execute("find /dbx/ -name '*.txt'")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "inner.txt" in out
    assert "notes.md" not in out


@pytest.mark.asyncio
async def test_find_type_d(ws):
    io = await ws.execute("find /dbx/ -type d")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "words.txt" not in out


@pytest.mark.asyncio
async def test_find_maxdepth(ws):
    io = await ws.execute("find /dbx/ -maxdepth 1")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "inner.txt" not in out
