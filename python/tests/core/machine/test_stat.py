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

from mirage.core.machine.stat import entry_stat, stat
from mirage.core.posix.types import PosixEntry
from mirage.types import FileType
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import ROW, bound, spec


def test_entry_stat_keeps_the_machine_s_kind_mode_times_and_owners():
    entry = PosixEntry(
        "f",
        0o640,
        12,
        1700000000,
        1700000001,
        1700000000123,
        1700000001000,
        1000,
        50,
        1,
        8,
        "",
    )
    got = entry_stat("x.py", entry)
    assert (got.type, got.size, got.mode, got.uid, got.gid) == (
        FileType.FILE,
        12,
        0o640,
        1000,
        50,
    )
    assert got.modified == "2023-11-14T22:13:20.123Z"
    assert got.atime == "2023-11-14T22:13:21.000Z"
    assert (got.nlink, got.blocks) == (1, 8)


@pytest.mark.parametrize(
    ("kind", "want", "size"),
    [
        ("d", FileType.DIRECTORY, None),
        ("p", FileType.FIFO, None),
        ("c", FileType.CHAR_DEVICE, None),
        ("l", FileType.FILE, 7),
        ("s", FileType.FILE, 7),
    ],
)
def test_entry_stat_maps_each_kind(kind, want, size):
    entry = PosixEntry(kind, 0o755, 7, 0, 0, 0, 0, 0, 0, 1, 0, "")
    got = entry_stat("n", entry)
    assert (got.type, got.size) == (want, size)


@pytest.mark.asyncio
async def test_stat_finds_the_path_alone():
    box = ScriptedMachine("box", lambda line, data: ok(ROW))
    got = await stat(bound(box), "box", spec("/x.txt"))
    assert (got.name, got.size, got.uid) == ("x.txt", 3, 0)
    assert box.lines == [
        "env LC_ALL=C find -L '/tmp/x.txt' -maxdepth 0 "
        "-printf '%y %m %s %T@ %A@ %U %G %n %b %P\\0'"
    ]


@pytest.mark.asyncio
async def test_stat_of_a_missing_path_is_enoent():
    said = b"find: '/tmp/x': No such file or directory\n"
    box = ScriptedMachine("box", lambda line, data: failed(said))
    with pytest.raises(FileNotFoundError):
        await stat(bound(box), "box", spec("/x"))
