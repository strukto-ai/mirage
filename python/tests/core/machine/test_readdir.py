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

from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.machine.readdir import readdir, tree
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import DIR, bound, spec

MISSING = b"find: '/tmp/d': No such file or directory\n"


@pytest.mark.asyncio
async def test_a_directory_on_two_machines_lists_each_name_once():
    a = ScriptedMachine(
        "a", lambda line, data: ok(DIR + b"f 644 1 0 0 0 0 1 0 out.csv\0")
    )
    b = ScriptedMachine(
        "b",
        lambda line, data: ok(
            DIR
            + b"f 644 2 0 0 0 0 1 0 out.csv\0f 644 9 0 0 0 0 1 0 model.bin\0"
        ),
    )
    names = [
        s.name for s in await readdir(bound(a, b), ["a", "b"], spec("/d"))
    ]
    assert names == ["model.bin", "out.csv"]
    assert a.lines[0].endswith(
        "-maxdepth 1 -printf '%y %m %s %T@ %A@ %U %G %n %b %P\\0'"
    )


@pytest.mark.asyncio
async def test_a_directory_only_one_machine_has_lists_there():
    a = ScriptedMachine("a", lambda line, data: failed(MISSING))
    b = ScriptedMachine(
        "b", lambda line, data: ok(DIR + b"f 644 1 0 0 0 0 1 0 x\0")
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
    f = ScriptedMachine("f", lambda line, data: ok(b"f 644 1 0 0 0 0 1 0 \0"))
    with pytest.raises(NotADirectoryError):
        await readdir(bound(a, f), ["a", "f"], spec("/d"))


@pytest.mark.asyncio
async def test_a_machine_that_cannot_list_fails_the_listing():
    denied = b"find: '/tmp/d': Permission denied\n"
    a = ScriptedMachine("a", lambda line, data: failed(denied))
    b = ScriptedMachine(
        "b", lambda line, data: ok(DIR + b"f 644 1 0 0 0 0 1 0 x\0")
    )
    with pytest.raises(PermissionError):
        await readdir(bound(a, b), ["a", "b"], spec("/d"))


def listing(*entries: bytes):
    return lambda line, data: ok(DIR + b"".join(entries))


@pytest.mark.asyncio
async def test_a_name_on_two_machines_lists_the_copy_written_last():
    a = ScriptedMachine(
        "a",
        listing(
            b"f 644 1 1700000009 0 0 0 1 0 out.csv\0",
            b"f 644 5 1700000000 0 0 0 1 0 log\0",
        ),
    )
    b = ScriptedMachine(
        "b",
        listing(
            b"f 644 2 1700000000 0 0 0 1 0 out.csv\0",
            b"d 755 4096 1700000004 0 0 0 2 8 log\0",
        ),
    )
    for accessor in (bound(a, b), bound(b, a)):
        found = await readdir(accessor, accessor.names(), spec("/d"))
        assert [(s.name, s.size) for s in found] == [
            ("log", None),
            ("out.csv", 1),
        ]


@pytest.mark.asyncio
async def test_copies_written_together_list_the_command_s_machine_s():
    a = ScriptedMachine("a", listing(b"f 644 1 5 0 0 0 1 0 x\0"))
    b = ScriptedMachine("b", listing(b"f 644 2 5 0 0 0 1 0 x\0"))
    accessor = bound(a, b)
    found = await readdir(accessor, ["a", "b"], spec("/d"))
    assert [s.size for s in found] == [1]
    token = bind_caller(current_caller().changed({"preferred_machine": "b"}))
    try:
        found = await readdir(accessor, ["a", "b"], spec("/d"))
        assert [s.size for s in found] == [2]
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_tree_merges_every_machine_and_leaves_a_failure_to_the_walk():
    a = ScriptedMachine(
        "a",
        listing(b"f 644 1 0 0 0 0 1 0 x\0", b"f 644 1 7 0 0 0 1 0 s/both\0"),
    )
    b = ScriptedMachine(
        "b",
        listing(b"f 644 2 0 0 0 0 1 0 y\0", b"f 644 2 9 0 0 0 1 0 s/both\0"),
    )
    accessor = bound(a, b)
    found = await tree(accessor, ["a", "b"], spec("/d"))
    assert found is not None
    assert sorted(found) == ["s/both", "x", "y"]
    assert (found["s/both"].name, found["s/both"].size) == ("both", 2)
    gone = ScriptedMachine("gone", lambda line, data: failed(b"find: lost\n"))
    assert await tree(bound(a, gone), ["a", "gone"], spec("/d")) is None
