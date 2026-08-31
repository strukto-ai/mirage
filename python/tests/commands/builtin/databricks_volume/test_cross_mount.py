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

import asyncio

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from tests.resource.databricks_volume.test_databricks_volume import (
    FakeFilesClient, make_resource, seed_file)

ROOT = "/Volumes/main/default/agent_files/root"


def _run(ws, cmd):

    async def _inner():
        io = await ws.execute(cmd)
        return await io.stdout_str(), await io.stderr_str(), io.exit_code

    return asyncio.run(_inner())


def _ws_with_dbx_tree():
    files = FakeFilesClient()
    files.add_directory(ROOT)
    files.add_directory(f"{ROOT}/tree")
    files.add_directory(f"{ROOT}/tree/sub")
    seed_file(files, f"{ROOT}/tree/a.txt", b"aaa\n")
    seed_file(files, f"{ROOT}/tree/sub/b.txt", b"bbb\n")
    dbx = make_resource(files)
    ram = RAMResource()
    ws = Workspace(
        {
            "/dbx": (dbx, MountMode.WRITE),
            "/m": (ram, MountMode.WRITE),
        }, )
    return ws, files, ram


def test_cp_recursive_databricks_to_ram():
    ws, _files, ram = _ws_with_dbx_tree()
    _out, _err, code = _run(ws, "cp -r /dbx/tree /m/copied")
    assert code == 0
    assert ram._store.files["/copied/a.txt"] == b"aaa\n"
    assert ram._store.files["/copied/sub/b.txt"] == b"bbb\n"


def test_cp_recursive_ram_to_databricks_creates_dirs():
    ws, files, ram = _ws_with_dbx_tree()
    ram._store.dirs.update({"/src", "/src/sub"})
    ram._store.files["/src/x.txt"] = b"xxx\n"
    ram._store.files["/src/sub/y.txt"] = b"yyy\n"
    _out, _err, code = _run(ws, "cp -r /m/src /dbx/put")
    assert code == 0
    assert files.downloads[f"{ROOT}/put/x.txt"] == b"xxx\n"
    assert files.downloads[f"{ROOT}/put/sub/y.txt"] == b"yyy\n"
    assert f"{ROOT}/put/sub" in files.directory_metadata


def test_mv_recursive_databricks_to_ram_removes_source():
    ws, files, ram = _ws_with_dbx_tree()
    _out, _err, code = _run(ws, "mv /dbx/tree /m/moved")
    assert code == 0
    assert ram._store.files["/moved/a.txt"] == b"aaa\n"
    assert ram._store.files["/moved/sub/b.txt"] == b"bbb\n"
    assert f"{ROOT}/tree/a.txt" not in files.downloads
    assert f"{ROOT}/tree" not in files.directory_metadata


def test_single_file_missing_parent_is_posix_error():
    # Option B / POSIX: a single-file copy never creates the destination's
    # parent directory; it errors like coreutils instead of mkdir -p.
    ws, _files, ram = _ws_with_dbx_tree()
    ram._store.files["/lone.txt"] = b"z\n"
    _out, _err, code = _run(ws, "cp /m/lone.txt /dbx/nope/deep/lone.txt")
    assert code == 1
