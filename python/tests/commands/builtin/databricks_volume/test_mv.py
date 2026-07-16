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
    seed_file(files, f"{ROOT}/src.txt", b"data")
    return files


@pytest.fixture
def write_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.WRITE)


@pytest.fixture
def read_ws(dbx_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(dbx_files)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_mv_file_moves_bytes(write_ws, dbx_files):
    io = await write_ws.execute("mv /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code == 0
    assert dbx_files.downloads[f"{ROOT}/dst.txt"] == b"data"
    assert f"{ROOT}/src.txt" not in dbx_files.downloads


@pytest.mark.asyncio
async def test_mv_writes_both_parents_mount_relative(write_ws):
    io = await write_ws.execute("mv /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code == 0
    assert "/dbx/src.txt" in io.writes
    assert "/dbx/dst.txt" in io.writes
    for key in io.writes:
        assert not key.startswith("/dbx/dbx/")


@pytest.mark.asyncio
async def test_mv_no_clobber_skips_existing(write_ws, dbx_files):
    seed_file(dbx_files, f"{ROOT}/dst.txt", b"keep")

    io = await write_ws.execute("mv -n /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code == 0
    assert dbx_files.downloads[f"{ROOT}/dst.txt"] == b"keep"
    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"data"


@pytest.mark.asyncio
async def test_mv_read_only_mount_rejected(read_ws, dbx_files):
    io = await read_ws.execute("mv /dbx/src.txt /dbx/dst.txt")

    assert io.exit_code != 0
    assert b"read-only" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"data"


@pytest.mark.asyncio
async def test_ops_rename(write_ws, dbx_files):
    await write_ws.ops.rename("/dbx/src.txt", "/dbx/renamed.txt")

    assert dbx_files.downloads[f"{ROOT}/renamed.txt"] == b"data"
    assert f"{ROOT}/src.txt" not in dbx_files.downloads


@pytest.mark.asyncio
async def test_mv_onto_same_path_errors_and_preserves_file(
        write_ws, dbx_files):
    io = await write_ws.execute("mv /dbx/src.txt /dbx/src.txt")

    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"data"
    assert f"{ROOT}/src.txt" not in dbx_files.delete_calls


@pytest.mark.asyncio
async def test_mv_into_dir_where_file_already_lives_errors_and_preserves_file(
        write_ws, dbx_files):
    io = await write_ws.execute("mv /dbx/src.txt /dbx/")

    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"data"


@pytest.mark.asyncio
async def test_ops_rename_onto_same_path_is_noop(write_ws, dbx_files):
    await write_ws.ops.rename("/dbx/src.txt", "/dbx/src.txt")

    assert dbx_files.downloads[f"{ROOT}/src.txt"] == b"data"
    assert f"{ROOT}/src.txt" not in dbx_files.delete_calls


@pytest.mark.asyncio
async def test_mv_multiple_sources_require_directory(write_ws, dbx_files):
    seed_file(dbx_files, f"{ROOT}/a.txt", b"AAA")
    seed_file(dbx_files, f"{ROOT}/b.txt", b"BBB")
    seed_file(dbx_files, f"{ROOT}/target.txt", b"target")

    io = await write_ws.execute("mv /dbx/a.txt /dbx/b.txt /dbx/target.txt")

    assert io.exit_code != 0
    assert io.stderr == b"mv: target '/dbx/target.txt': Not a directory\n"
    assert dbx_files.downloads[f"{ROOT}/a.txt"] == b"AAA"
    assert dbx_files.downloads[f"{ROOT}/b.txt"] == b"BBB"
    assert dbx_files.downloads[f"{ROOT}/target.txt"] == b"target"
    assert f"{ROOT}/a.txt" not in dbx_files.delete_calls
    assert f"{ROOT}/b.txt" not in dbx_files.delete_calls


@pytest.mark.asyncio
async def test_mv_missing_source_reports_cannot_stat(write_ws, dbx_files):
    io = await write_ws.execute("mv /dbx/missing /dbx/missing")

    assert io.exit_code != 0
    assert b"cannot stat" in io.stderr
    assert b"are the same file" not in io.stderr


@pytest.mark.asyncio
async def test_mv_into_itself_errors_and_preserves_source(write_ws, dbx_files):
    seed_directory(dbx_files, f"{ROOT}/d")
    seed_file(dbx_files, f"{ROOT}/d/a.txt", b"aaa")

    io = await write_ws.execute("mv /dbx/d /dbx/d")

    assert io.exit_code != 0
    assert b"subdirectory of itself" in io.stderr
    assert dbx_files.downloads[f"{ROOT}/d/a.txt"] == b"aaa"
    assert f"{ROOT}/d" in dbx_files.directory_metadata
    assert f"{ROOT}/d/a.txt" not in dbx_files.delete_calls
