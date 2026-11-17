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
from mirage.core.machine.place import holder, holders, lands, stage
from mirage.execution.types import MachineName
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import bound, holding, spec


def running_on(name: str):
    return bind_caller(
        current_caller().changed({"machine": MachineName("scripted", name)})
    )


@pytest.mark.asyncio
async def test_one_machine_asks_nothing():
    box = ScriptedMachine("box", holding())
    accessor = bound(box)
    assert await holders(accessor, spec("/x")) == ["box"]
    assert await lands(accessor, spec("/x")) == "box"
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
async def test_a_name_on_two_machines_is_the_running_program_s_or_refused():
    a = ScriptedMachine("a", holding("/tmp/x"))
    b = ScriptedMachine("b", holding("/tmp/x"))
    accessor = bound(a, b)
    with pytest.raises(OSError, match="on several machines: a, b"):
        await holder(accessor, spec("/x"))
    token = running_on("b")
    try:
        assert stage(accessor) == "b"
        assert await holder(accessor, spec("/x")) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_a_new_name_lands_on_the_program_s_machine_else_the_default():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding())
    accessor = bound(a, b)
    assert accessor.default_machine == "a"
    assert await lands(accessor, spec("/new")) == "a"
    token = running_on("b")
    try:
        assert await lands(accessor, spec("/new")) == "b"
    finally:
        reset_caller(token)


@pytest.mark.asyncio
async def test_an_existing_name_is_written_where_it_is():
    a = ScriptedMachine("a", holding())
    b = ScriptedMachine("b", holding("/tmp/kept"))
    token = running_on("a")
    try:
        assert await lands(bound(a, b), spec("/kept")) == "b"
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
