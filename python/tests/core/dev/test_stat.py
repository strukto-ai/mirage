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

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.dev.stat import stat
from mirage.types import FileType, MountMode, PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

FD = PathSpec(vfs_path="fd/63", virtual="/dev/fd/63", directory="/dev/fd/")


def _store() -> DevStore:
    store = DevStore(DevFiles("owner"))
    store.files.allocate_input(DevicePipe(True))
    return store


@pytest.mark.asyncio
async def test_fifo_without_attrs_is_rw_for_its_owner():
    s = await stat(RAMAccessor(_store()), FD)
    assert (s.name, s.type, s.size, s.mode) == (
        "63",
        FileType.FIFO,
        None,
        0o600,
    )
    assert (s.uid, s.gid, s.atime, s.modified) == (None, None, None, None)


@pytest.mark.asyncio
async def test_fifo_reports_its_stored_attrs():
    store = _store()
    store.attrs["/fd/63"] = {
        "mode": 0o640,
        "uid": 7,
        "gid": 8,
        "atime": "2020-01-02T03:04:05Z",
    }
    store.modified["/fd/63"] = "2020-01-02T03:04:06Z"
    s = await stat(RAMAccessor(store), FD)
    assert (s.mode, s.uid, s.gid) == (0o640, 7, 8)
    assert (s.atime, s.modified) == (
        "2020-01-02T03:04:05Z",
        "2020-01-02T03:04:06Z",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        (
            "stat -L -c '%F %f %a %A %s' <(true)",
            "fifo 1180 600 prw------- 0\n",
        ),
        (
            'f() { chmod 640 "$1"; stat -L -c \'%a %A\' "$1"; }; f <(true)',
            "640 prw-r-----\n",
        ),
        (
            'f() { chmod u+x "$1"; stat -L -c \'%a\' "$1"; }; f <(true)',
            "700\n",
        ),
        (
            "f() { touch -d '2020-01-02 03:04:05' \"$1\"; "
            "stat -L -c '%y' \"$1\"; }; f <(true)",
            "2020-01-02 03:04:05.000000000 +0000\n",
        ),
    ],
)
async def test_stat_of_a_substitution(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, expected, "")
    finally:
        await ws.close()
