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
    files.create_directory(f"{ROOT}/d")
    seed_file(files, f"{ROOT}/d/a.txt", b"a")
    files.create_directory(f"{ROOT}/d/sub")
    seed_file(files, f"{ROOT}/d/sub/b.txt", b"b")
    return files


@pytest.fixture
def write_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.WRITE)


@pytest.fixture
def read_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_rm_recursive_removes_tree(write_ws, dbx_files):
    io = await write_ws.execute("rm -r /dbx/d")

    assert io.exit_code == 0
    assert f"{ROOT}/d" not in dbx_files.directory_metadata
    assert f"{ROOT}/d/sub/b.txt" not in dbx_files.downloads


@pytest.mark.asyncio
async def test_rm_recursive_writes_are_mount_relative(write_ws):
    io = await write_ws.execute("rm -r /dbx/d")

    assert io.exit_code == 0
    assert io.writes
    for key in io.writes:
        assert key.startswith("/dbx/")
        assert not key.startswith("/dbx/dbx/")


@pytest.mark.asyncio
async def test_plain_rm_on_directory_fails(write_ws, dbx_files):
    io = await write_ws.execute("rm /dbx/d")

    assert io.exit_code != 0
    assert f"{ROOT}/d" in dbx_files.directory_metadata


@pytest.mark.asyncio
async def test_rm_force_missing_succeeds(write_ws):
    io = await write_ws.execute("rm -f /dbx/missing.txt")

    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rm_missing_fails(write_ws):
    io = await write_ws.execute("rm /dbx/missing.txt")

    assert io.exit_code != 0


@pytest.mark.asyncio
async def test_rm_recursive_read_only_rejected(read_ws, dbx_files):
    io = await read_ws.execute("rm -r /dbx/d")

    assert io.exit_code != 0
    assert b"read-only" in io.stderr
    assert f"{ROOT}/d" in dbx_files.directory_metadata
