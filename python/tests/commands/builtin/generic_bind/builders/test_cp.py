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

import os

import pytest

from mirage import MountMode, Workspace
from mirage.vfs.disk import DiskVFS


@pytest.mark.asyncio
@pytest.mark.skipif(os.geteuid() == 0, reason="root reads every folder")
async def test_cp_r_names_a_folder_it_may_not_open_and_copies_the_rest(
    tmp_path,
):
    # GNU (coreutils 9.7): `cp: cannot access 'src/locked': Permission
    # denied`, dst/locked is made, every other entry copies, exit 1.
    (tmp_path / "src" / "locked").mkdir(parents=True)
    (tmp_path / "src" / "open").mkdir()
    (tmp_path / "src" / "locked" / "x.txt").write_text("x\n")
    (tmp_path / "src" / "open" / "y.txt").write_text("y\n")
    (tmp_path / "src" / "z.txt").write_text("z\n")
    (tmp_path / "src" / "locked").chmod(0)
    ws = Workspace({"/d": DiskVFS(str(tmp_path))}, mode=MountMode.WRITE)
    try:
        io = await ws.shell("cp -r /d/src /d/dst")
        assert io.exit_code == 1
        assert await io.stderr_str() == (
            "cp: cannot access '/d/src/locked': Permission denied\n"
        )
        assert (tmp_path / "dst" / "locked").is_dir()
        assert (tmp_path / "dst" / "open" / "y.txt").read_text() == "y\n"
        assert (tmp_path / "dst" / "z.txt").read_text() == "z\n"
    finally:
        (tmp_path / "src" / "locked").chmod(0o755)
        await ws.close()
