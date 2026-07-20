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
    FakeFiles, make_resource, seed_directory, seed_file)

ROOT = "/Volumes/main/default/agent_files/root"


@pytest.fixture
def dbx_files() -> FakeFiles:
    files = FakeFiles()
    seed_directory(files, ROOT)
    seed_file(files, f"{ROOT}/words.txt", b"beta\nalpha\nalpha\n")
    files.create_directory(f"{ROOT}/sub")
    seed_file(files, f"{ROOT}/sub/inner.txt", b"gamma\nalpha\n")
    files.create_directory(f"{ROOT}/sub/deep")
    seed_file(files, f"{ROOT}/sub/deep/leaf.txt", b"leaf\n")
    return files


@pytest.fixture
def ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_tree_lists_nested_entries(ws):
    io = await ws.execute("tree /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "inner.txt" in out


@pytest.mark.asyncio
async def test_tree_max_depth(ws):
    io = await ws.execute("tree -L 1 /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "inner.txt" not in out
    assert "leaf.txt" not in out


@pytest.mark.asyncio
async def test_tree_dirs_only(ws):
    io = await ws.execute("tree -d /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "words.txt" not in out
