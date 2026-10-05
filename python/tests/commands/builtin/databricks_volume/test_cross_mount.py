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
from mirage.vfs.ram import RAMVFS
from tests.vfs.databricks_volume.test_databricks_volume import (
    FakeFiles,
    make_vfs,
    seed_file,
)

ROOT = "/Volumes/main/default/agent_files/root"


def _run(ws, cmd):
    async def _inner():
        io = await ws.shell(cmd)
        return await io.stdout_str(), await io.stderr_str(), io.exit_code

    return asyncio.run(_inner())


def _ws_with_dbx_tree():
    files = FakeFiles()
    files.create_directory(ROOT)
    files.create_directory(f"{ROOT}/tree")
    files.create_directory(f"{ROOT}/tree/sub")
    seed_file(files, f"{ROOT}/tree/a.txt", b"aaa\n")
    seed_file(files, f"{ROOT}/tree/sub/b.txt", b"bbb\n")
    dbx = make_vfs(files)
    ram = RAMVFS()
    ws = Workspace(
        {
            "/dbx": (dbx, MountMode.WRITE),
            "/m": (ram, MountMode.WRITE),
        },
    )
    return ws, files, ram


def test_single_file_missing_parent_is_posix_error():
    # Option B / POSIX: a single-file copy never creates the destination's
    # parent directory; it errors like coreutils instead of mkdir -p.
    ws, _files, ram = _ws_with_dbx_tree()
    ram._store.files["/lone.txt"] = b"z\n"
    _out, _err, code = _run(ws, "cp /m/lone.txt /dbx/nope/deep/lone.txt")
    assert code == 1
