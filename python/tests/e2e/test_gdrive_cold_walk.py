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
import pytest_asyncio

from mirage.types import MountMode
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import GoogleAccount

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def cold(google_account: GoogleAccount):
    """A gdrive tree the index has never seen.

    The cross-mount matrix seeds through the workspace, which primes the
    index on the way in, so it cannot reach the cold path #270 is about.
    Seeding straight into Drive leaves the index empty, which is the state
    where the walk used to stop at the top level.
    """
    await google_account.put("tree/a.txt", b"aaa\n")
    await google_account.put("tree/sub/b.txt", b"bbb\n")
    await google_account.put("tree/sub/deep/c.txt", b"ccc\n")
    gdrive = GoogleDriveVFS(google_account.config(GoogleDriveConfig))
    ws = Workspace(
        {
            "/gdrive/": (gdrive, MountMode.WRITE),
            "/ram/": (RAMVFS(), MountMode.WRITE),
        }
    )
    try:
        yield ws
    finally:
        await ws.close()


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return await io.stdout_str(), io.exit_code


async def test_cold_readdir_descends_into_a_nested_subdirectory(cold):
    """A cold listing must not need a prior ls to resolve children."""
    out, code = await _run(cold, "ls /gdrive/tree/sub/deep")
    assert code == 0
    assert out == "c.txt\n"


async def test_cold_cross_mount_cp_r_keeps_nested_entries(cold):
    """#270: the walk copied the top level and dropped everything under it."""
    _, code = await _run(cold, "cp -r /gdrive/tree /ram/copied")
    assert code == 0
    assert (await _run(cold, "cat /ram/copied/a.txt"))[0] == "aaa\n"
    assert (await _run(cold, "cat /ram/copied/sub/b.txt"))[0] == "bbb\n"
    assert (await _run(cold, "cat /ram/copied/sub/deep/c.txt"))[0] == "ccc\n"


async def test_cold_cross_mount_move_carries_nested_entries_to_the_destination(
    cold,
):
    """The move's copy phase walks the same tree as cp -r, and the source
    goes once the copy has landed."""
    _, code = await _run(cold, "mv /gdrive/tree /ram/moved")
    assert code == 0
    assert (await _run(cold, "cat /ram/moved/a.txt"))[0] == "aaa\n"
    assert (await _run(cold, "cat /ram/moved/sub/b.txt"))[0] == "bbb\n"
    assert (await _run(cold, "cat /ram/moved/sub/deep/c.txt"))[0] == "ccc\n"
    assert (await _run(cold, "ls /gdrive/tree"))[1] != 0
