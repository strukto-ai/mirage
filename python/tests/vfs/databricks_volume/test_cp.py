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
from tests.vfs.databricks_volume.test_databricks_volume import (
    FakeFiles,
    make_vfs,
    seed_directory,
    seed_file,
)

ROOT = "/Volumes/main/default/agent_files/root"


@pytest.fixture
def dbx_files() -> FakeFiles:
    files = FakeFiles()
    seed_directory(files, ROOT)
    seed_file(files, f"{ROOT}/src.txt", b"hello")
    return files


@pytest.fixture
def write_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_vfs(dbx_files)}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_cp_directory_without_recursive_fails(write_ws, dbx_files):
    seed_directory(dbx_files, f"{ROOT}/d")

    io = await write_ws.shell("cp /dbx/d /dbx/d2")

    assert io.exit_code != 0


@pytest.mark.asyncio
async def test_cp_missing_source_reports_cannot_stat(write_ws, dbx_files):
    io = await write_ws.shell("cp /dbx/missing /dbx/missing")

    assert io.exit_code != 0
    assert b"cannot stat" in io.stderr
    assert b"are the same file" not in io.stderr
