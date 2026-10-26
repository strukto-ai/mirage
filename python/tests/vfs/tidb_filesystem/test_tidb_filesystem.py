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

from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio

from mirage import MountMode, Workspace
from mirage.types import VFSName
from mirage.vfs.tidb_filesystem import (
    TiDBFilesystemConfig,
    TiDBFilesystemVFS,
)
from tests.fixtures.drive9_api import TOKEN, FakeDrive9, serve


@pytest.fixture
def drive9() -> Iterator[FakeDrive9]:
    with serve(FakeDrive9(dirs={"/ws"})) as fake:
        yield fake


@pytest_asyncio.fixture
async def ws(drive9: FakeDrive9) -> AsyncIterator[Workspace]:
    vfs = TiDBFilesystemVFS(
        TiDBFilesystemConfig(host=drive9.url, token=TOKEN, root_path="/ws")
    )
    workspace = Workspace({"/fs": vfs}, mode=MountMode.WRITE)
    yield workspace
    await workspace.close()


async def _run(ws: Workspace, line: str) -> tuple[int, str, str]:
    io = await ws.shell(line)
    return io.exit_code, await io.stdout_str(), await io.stderr_str()


def test_state_redacts_the_token():
    vfs = TiDBFilesystemVFS(TiDBFilesystemConfig(host="https://h", token="t"))

    state = vfs.get_state()

    assert state["type"] == VFSName.TIDB_FILESYSTEM
    assert state["config"]["token"] == "<REDACTED>"
    assert state["config"]["host"] == "https://h"


def test_copy_is_left_to_read_and_write():
    vfs = TiDBFilesystemVFS(TiDBFilesystemConfig(host="https://h", token="t"))

    assert not vfs.supports("copy")
    assert vfs.supports("rm_r")


@pytest.mark.asyncio
async def test_write_list_and_read(ws, drive9):
    assert await _run(ws, "mkdir /fs/d && echo hi > /fs/d/a.txt") == (
        0,
        "",
        "",
    )
    assert await _run(ws, "ls /fs/d; cat /fs/d/a.txt") == (
        0,
        "a.txt\nhi\n",
        "",
    )
    assert drive9.files == {"/ws/d/a.txt": b"hi\n"}


@pytest.mark.asyncio
async def test_redirect_under_a_missing_folder_fails(ws, drive9):
    code, _, err = await _run(ws, "echo hi > /fs/nope/a.txt")

    assert code == 1
    assert err == "/fs/nope/a.txt: No such file or directory\n"
    assert "/ws/nope" not in drive9.dirs


@pytest.mark.asyncio
async def test_cp_keeps_the_copies_apart(ws, drive9):
    drive9.files["/ws/a.txt"] = b"one\n"

    code, out, _ = await _run(
        ws, "cp /fs/a.txt /fs/b.txt && echo two > /fs/b.txt && cat /fs/a.txt"
    )

    assert (code, out) == (0, "one\n")
    assert drive9.count("POST", "/ws/b.txt?copy") == 0


@pytest.mark.asyncio
async def test_mv_a_directory_is_one_rename(ws, drive9):
    drive9.dirs.add("/ws/d")
    drive9.files["/ws/d/f"] = b"x"

    code, _, _ = await _run(ws, "mv /fs/d /fs/e")

    assert code == 0
    assert drive9.files == {"/ws/e/f": b"x"}
    assert drive9.count("POST", "/ws/e?rename") == 1


@pytest.mark.asyncio
async def test_rm_r_is_one_delete(ws, drive9):
    drive9.dirs.update({"/ws/d", "/ws/d/e"})
    drive9.files.update({"/ws/d/e/f": b"x", "/ws/d/g": b"y"})

    code, _, _ = await _run(ws, "rm -r /fs/d")

    assert code == 0
    assert drive9.dirs == {"/ws"}
    assert drive9.count("DELETE") == 1


@pytest.mark.asyncio
async def test_cat_of_a_directory_is_eisdir(ws, drive9):
    drive9.dirs.add("/ws/d")

    assert await _run(ws, "cat /fs/d") == (
        1,
        "",
        "cat: /fs/d: Is a directory\n",
    )


@pytest.mark.asyncio
async def test_large_file_round_trip(ws, drive9):
    drive9.part_size = 100_000

    code, out, _ = await _run(
        ws,
        "seq 1 50000 > /fs/big.txt && tail -n 1 /fs/big.txt && wc -c /fs/big.txt",
    )

    assert (code, out) == (0, "50000\n288894 /fs/big.txt\n")
    assert drive9.count("PUT", "/s3/upload") == 3
    assert drive9.leaked == []
