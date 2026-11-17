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

from mirage.accessor.machine import MachineAccessor
from mirage.vfs.machine.config import MachineVFSConfig
from tests.fixtures.machine import (
    JoinedMachine,
    ScriptedMachine,
    failed,
    ok,
    table_of,
)


@pytest.mark.asyncio
async def test_run_answers_status_output_and_errors():
    box = ScriptedMachine("box", lambda line, data: failed(b"no\n", 2))
    accessor = MachineAccessor(MachineVFSConfig())
    accessor.bind_machines(table_of(box), "box")
    assert await accessor.run("box", "true") == (2, b"", b"no\n")
    assert box.lines == ["true"]


@pytest.mark.asyncio
async def test_a_merged_exec_gives_a_failure_s_output_as_its_errors():
    def merged(line, data):
        return failed(b"cat: x: gone\n")

    box = JoinedMachine("box", merged)
    accessor = MachineAccessor(MachineVFSConfig())
    accessor.bind_machines(table_of(box), "box")
    assert await accessor.run("box", "cat x") == (1, b"", b"cat: x: gone\n")


def test_an_unbound_accessor_says_so():
    with pytest.raises(ValueError, match="not bound to machines"):
        MachineAccessor(MachineVFSConfig()).names()


def test_names_follow_the_config_or_every_machine():
    a = ScriptedMachine("a", lambda line, data: ok())
    b = ScriptedMachine("b", lambda line, data: ok())
    every = MachineAccessor(MachineVFSConfig())
    every.bind_machines(table_of(a, b), "b")
    assert (every.names(), every.default_machine) == (["a", "b"], "b")
    one = MachineAccessor(MachineVFSConfig(machines=("b",)))
    one.bind_machines(table_of(a, b), "a")
    assert (one.names(), one.default_machine) == (["b"], "b")
