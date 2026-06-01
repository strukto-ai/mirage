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
    FakeFiles, make_resource, seed_directory)

ROOT = "/Volumes/main/default/agent_files/root"


@pytest.fixture
def dbx_files() -> FakeFiles:
    files = FakeFiles()
    seed_directory(files, ROOT)
    return files


@pytest.fixture
def write_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.WRITE)


@pytest.fixture
def read_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_mkdir_creates_directory(write_ws, dbx_files):
    io = await write_ws.execute("mkdir /dbx/newdir")

    assert io.exit_code == 0
    assert f"{ROOT}/newdir" in dbx_files.directory_metadata


@pytest.mark.asyncio
async def test_mkdir_parent_missing_fails(write_ws):
    io = await write_ws.execute("mkdir /dbx/a/b")

    assert io.exit_code != 0


@pytest.mark.asyncio
async def test_mkdir_parents_creates_chain(write_ws, dbx_files):
    io = await write_ws.execute("mkdir -p /dbx/a/b/c")

    assert io.exit_code == 0
    assert f"{ROOT}/a/b/c" in dbx_files.directory_metadata


@pytest.mark.asyncio
async def test_mkdir_writes_are_mount_relative(write_ws):
    io = await write_ws.execute("mkdir /dbx/newdir")

    assert io.exit_code == 0
    for key in io.writes:
        assert key.startswith("/dbx/")
        assert not key.startswith("/dbx/dbx/")


@pytest.mark.asyncio
async def test_mkdir_read_only_mount_rejected(read_ws, dbx_files):
    io = await read_ws.execute("mkdir /dbx/newdir")

    assert io.exit_code != 0
    assert b"read-only" in io.stderr
    assert dbx_files.create_directory_calls == []


@pytest.mark.asyncio
async def test_ops_mkdir(write_ws, dbx_files):
    await write_ws.ops.mkdir("/dbx/opdir")

    assert f"{ROOT}/opdir" in dbx_files.directory_metadata


@pytest.mark.asyncio
async def test_ops_mkdir_read_only_rejected(read_ws):
    with pytest.raises(PermissionError):
        await read_ws.ops.mkdir("/dbx/opdir")
