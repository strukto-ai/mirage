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

from mirage.core.machine.readdir import readdir
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import DIR, bound, spec

MISSING = b"find: '/tmp/d': No such file or directory\n"


@pytest.mark.asyncio
async def test_a_directory_on_two_machines_lists_each_name_once():
    a = ScriptedMachine(
        "a", lambda line, data: ok(DIR + b"f 644 1 0 0 r r out.csv\0")
    )
    b = ScriptedMachine(
        "b",
        lambda line, data: ok(
            DIR + b"f 644 2 0 0 r r out.csv\0f 644 9 0 0 r r model.bin\0"
        ),
    )
    names = [
        s.name for s in await readdir(bound(a, b), ["a", "b"], spec("/d"))
    ]
    assert names == ["model.bin", "out.csv"]
    assert a.lines[0].endswith(
        "-maxdepth 1 -printf '%y %m %s %T@ %A@ %u %g %P\\0'"
    )


@pytest.mark.asyncio
async def test_a_directory_only_one_machine_has_lists_there():
    a = ScriptedMachine("a", lambda line, data: failed(MISSING))
    b = ScriptedMachine(
        "b", lambda line, data: ok(DIR + b"f 644 1 0 0 r r x\0")
    )
    names = [
        s.name for s in await readdir(bound(a, b), ["a", "b"], spec("/d"))
    ]
    assert names == ["x"]


@pytest.mark.asyncio
async def test_no_machine_holding_it_is_enoent_and_a_file_is_enotdir():
    a = ScriptedMachine("a", lambda line, data: failed(MISSING))
    with pytest.raises(FileNotFoundError):
        await readdir(bound(a), ["a"], spec("/d"))
    f = ScriptedMachine("f", lambda line, data: ok(b"f 644 1 0 0 r r \0"))
    with pytest.raises(NotADirectoryError):
        await readdir(bound(a, f), ["a", "f"], spec("/d"))


@pytest.mark.asyncio
async def test_a_machine_that_cannot_list_fails_the_listing():
    denied = b"find: '/tmp/d': Permission denied\n"
    a = ScriptedMachine("a", lambda line, data: failed(denied))
    b = ScriptedMachine(
        "b", lambda line, data: ok(DIR + b"f 644 1 0 0 r r x\0")
    )
    with pytest.raises(PermissionError):
        await readdir(bound(a, b), ["a", "b"], spec("/d"))
