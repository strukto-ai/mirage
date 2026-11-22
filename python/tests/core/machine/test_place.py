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
from mirage.core.machine.place import (
    chosen,
    command_machine,
    holder,
    holders,
    kernel_view,
    new_name_machine,
    running_machine,
    write_machine,
)
from mirage.core.machine.types import Holder
from mirage.execution.types import MachineName
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import FakeFiles, bound, holding, spec


def running_on(name: str):
    return bind_caller(
        current_caller().changed({"machine": MachineName("scripted", name)})
    )


def preferring(name: str):
    return bind_caller(current_caller().changed({"preferred_machine": name}))


@pytest.mark.asyncio
async def test_one_machine_asks_nothing():
    box = ScriptedMachine("box", holding())
    accessor = bound(box)
    assert await holders(accessor, spec("/x")) == [Holder("box")]
    assert await write_machine(accessor, spec("/x")) == "box"
    assert box.lines == []


@pytest.mark.asyncio
async def test_a_name_is_read_where_it_is():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding("/tmp/out.csv"))
    accessor = bound(a, b)
    assert await holder(accessor, spec("/out.csv")) == "b"
    with pytest.raises(FileNotFoundError):
        await holder(accessor, spec("/none"))


@pytest.mark.asyncio
async def test_a_name_on_two_machines_is_the_copy_written_last():
    old = ScriptedMachine("old", holding("/tmp/x", written=1700000000))
    new = ScriptedMachine("new", holding("/tmp/x", written=1700000009))
    assert await holder(bound(old, new), spec("/x")) == "new"
    assert await holder(bound(new, old), spec("/x")) == "new"
    held = await holders(bound(old, new), spec("/x"))
    assert [one.machine for one in held] == ["old", "new"]
    assert [one.written for one in held] == [1700000000000, 1700000009000]


@pytest.mark.asyncio
async def test_a_newer_copy_wins_over_the_command_s_machine():
    old = ScriptedMachine("old", holding("/tmp/x", written=1700000000))
    new = ScriptedMachine("new", holding("/tmp/x", written=1700000009))
    accessor = bound(old, new)
    token = running_on("old")
    try:
        assert await holder(accessor, spec("/x")) == "new"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_copies_written_together_go_to_the_command_s_machine():
    a = ScriptedMachine("a", holding("/tmp/x"))
    b = ScriptedMachine("b", holding("/tmp/x"))
    accessor = bound(a, b)
    assert await holder(accessor, spec("/x")) == "a"
    token = running_on("b")
    try:
        assert running_machine(accessor) == "b"
        assert command_machine(accessor) == "b"
        assert await holder(accessor, spec("/x")) == "b"
    finally:
        reset_caller(token)
    token = preferring("b")
    try:
        assert running_machine(accessor) is None
        assert command_machine(accessor) == "b"
        assert await holder(accessor, spec("/x")) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_a_program_s_machine_comes_before_the_preferred_one():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding())
    accessor = bound(a, b)
    token = bind_caller(
        current_caller().changed(
            {
                "machine": MachineName("scripted", "b"),
                "preferred_machine": "a",
            }
        )
    )
    try:
        assert command_machine(accessor) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_a_machine_off_the_mount_is_not_the_command_s():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding())
    accessor = bound(a, b, machines=("a",))
    token = preferring("b")
    try:
        assert command_machine(accessor) is None
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_a_kernel_s_view_answers_for_the_command_s_machine():
    a = ScriptedMachine("a", holding("/proc/cpuinfo", written=1700000000))
    b = ScriptedMachine("b", holding("/proc/cpuinfo", written=1700000009))
    accessor = bound(a, b, root="/")
    path = spec("/proc/cpuinfo", prefix="")
    assert kernel_view(accessor, path) == "a"
    assert await holder(accessor, path) == "a"
    assert b.lines == []
    token = preferring("b")
    try:
        assert await holder(accessor, path) == "b"
    finally:
        reset_caller(token)
    assert kernel_view(accessor, spec("/tmp/x", prefix="")) is None
    assert kernel_view(bound(a, root="/"), path) is None


def test_chosen_takes_the_only_holder_unasked():
    a = ScriptedMachine("a", holding())
    assert chosen(bound(a), [Holder("a")]) == Holder("a")


@pytest.mark.asyncio
async def test_a_new_name_lands_on_the_command_s_machine_else_the_default():
    a = ScriptedMachine("a", FakeFiles().answer)
    b = ScriptedMachine("b", FakeFiles().answer)
    accessor = bound(a, b)
    assert accessor.default_machine == "a"
    assert await write_machine(accessor, spec("/new")) == "a"
    for token in (running_on("b"), preferring("b")):
        try:
            assert await write_machine(accessor, spec("/new")) == "b"
        finally:
            reset_caller(token)


@pytest.mark.asyncio
async def test_a_new_name_lands_where_its_folder_is():
    a = ScriptedMachine("a", FakeFiles().answer)
    b = ScriptedMachine("b", FakeFiles({"/tmp/d/kept": b"1"}).answer)
    accessor = bound(a, b)
    assert await new_name_machine(accessor, spec("/d/new")) == "b"
    assert await write_machine(accessor, spec("/d/new")) == "b"
    token = preferring("a")
    try:
        assert await write_machine(accessor, spec("/d/new")) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_parents_look_up_to_the_nearest_folder_a_machine_holds():
    a = ScriptedMachine("a", FakeFiles().answer)
    b = ScriptedMachine("b", FakeFiles({"/tmp/g/kept": b"1"}).answer)
    accessor = bound(a, b)
    deep = spec("/g/sub/deep")
    assert await write_machine(accessor, deep, parents=True) == "b"
    assert await write_machine(accessor, deep) == "a"
    fresh = spec("/fresh/sub/deep")
    assert await write_machine(accessor, fresh, parents=True) == "a"


@pytest.mark.asyncio
async def test_an_existing_name_is_written_where_it_is():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding("/tmp/kept"))
    token = running_on("a")
    try:
        assert await write_machine(bound(a, b), spec("/kept")) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_what_a_program_replaces_lands_on_its_own_machine():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding("/tmp/kept"))
    accessor = bound(a, b)
    assert await write_machine(accessor, spec("/kept"), replaces=True) == "b"
    token = running_on("a")
    try:
        got = await write_machine(accessor, spec("/kept"), replaces=True)
        assert got == "a"
    finally:
        reset_caller(token)
    token = preferring("a")
    try:
        got = await write_machine(accessor, spec("/kept"), replaces=True)
        assert got == "b"
    finally:
        reset_caller(token)


def test_a_configured_default_machine_wins():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding())
    assert bound(a, b, default_machine="b").default_machine == "b"


def test_a_mount_naming_no_such_machine_is_refused():
    a = ScriptedMachine("a", holding())
    with pytest.raises(ValueError, match="unknown machine: 'gpu'"):
        bound(a, machines=("gpu",))
