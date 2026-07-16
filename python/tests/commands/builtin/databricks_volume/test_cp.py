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
    seed_file(files, f"{ROOT}/src.txt", b"hello")
    return files


@pytest.fixture
def write_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.WRITE)


@pytest.fixture
def read_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_cp_file_preserves_bytes(write_ws, dbx_files):
    io = await write_ws.execute("cp /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code == 0
    assert dbx_files.downloads[f"{ROOT}/dst.txt"] == b"hello"


@pytest.mark.asyncio
async def test_cp_directory_without_recursive_fails(write_ws, dbx_files):
    seed_directory(dbx_files, f"{ROOT}/d")

    io = await write_ws.execute("cp /dbx/d /dbx/d2")

    assert io.exit_code != 0


@pytest.mark.asyncio
async def test_cp_writes_are_mount_relative(write_ws):
    io = await write_ws.execute("cp /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code == 0
    for key in io.writes:
        assert key.startswith("/dbx/")
        assert not key.startswith("/dbx/dbx/")


@pytest.mark.asyncio
async def test_cp_read_only_mount_rejected(read_ws, dbx_files):
    io = await read_ws.execute("cp /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code != 0
    assert b"read-only" in io.stderr
    assert f"{ROOT}/dst.txt" not in dbx_files.downloads


@pytest.mark.asyncio
async def test_cp_onto_same_path_errors_and_preserves_file(
        write_ws, dbx_files):
    io = await write_ws.execute("cp /dbx/src.txt /dbx/src.txt")

    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"hello"


@pytest.mark.asyncio
async def test_cp_multiple_sources_require_directory(write_ws, dbx_files):
    seed_file(dbx_files, f"{ROOT}/a.txt", b"AAA")
    seed_file(dbx_files, f"{ROOT}/b.txt", b"BBB")
    seed_file(dbx_files, f"{ROOT}/target.txt", b"target")

    io = await write_ws.execute("cp /dbx/a.txt /dbx/b.txt /dbx/target.txt")

    assert io.exit_code != 0
    assert io.stderr == b"cp: target '/dbx/target.txt': Not a directory\n"
    assert dbx_files.downloads[f"{ROOT}/a.txt"] == b"AAA"
    assert dbx_files.downloads[f"{ROOT}/b.txt"] == b"BBB"
    assert dbx_files.downloads[f"{ROOT}/target.txt"] == b"target"


@pytest.mark.asyncio
async def test_cp_missing_source_reports_cannot_stat(write_ws, dbx_files):
    io = await write_ws.execute("cp /dbx/missing /dbx/missing")

    assert io.exit_code != 0
    assert b"cannot stat" in io.stderr
    assert b"are the same file" not in io.stderr


@pytest.mark.asyncio
async def test_cp_recursive_into_itself_errors_and_preserves_tree(
        write_ws, dbx_files):
    seed_directory(dbx_files, f"{ROOT}/d")
    seed_file(dbx_files, f"{ROOT}/d/a.txt", b"aaa")

    io = await write_ws.execute("cp -r /dbx/d /dbx/d")

    assert io.exit_code != 0
    assert b"into itself" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/d/a.txt"] == b"aaa"
    assert f"{ROOT}/d/d" not in dbx_files.directory_metadata
