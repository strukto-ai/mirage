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

from mirage.commands.spec.shell import SHELL_SPECS
from mirage.execution.process.table import ProcessTable
from mirage.io import IOResult
from mirage.workspace.executor.builtins.machine_view import (
    MachineScope,
    in_scope,
    machine_scope,
    option_refusal,
    permuted_options,
    process_scope,
    tell_once,
    with_machine,
)
from mirage.workspace.types import ExecutionNode


def table(*ids: str) -> ProcessTable:
    processes = ProcessTable("w")
    processes.machine_ids = lambda: list(ids)
    return processes


def test_every_machine_without_a_name():
    scope = machine_scope(table("docker:a", "e2b:b"), None)
    assert scope == MachineScope(("docker:a", "e2b:b"))
    assert scope.several


def test_a_name_or_an_id_picks_one():
    processes = table("docker:a", "e2b:b")
    assert machine_scope(processes, "b") == MachineScope(("e2b:b",), True)
    assert machine_scope(processes, "e2b:b") == MachineScope(("e2b:b",), True)


def test_an_unknown_name_picks_none():
    assert machine_scope(table("docker:a"), "nosuch") is None


def test_no_machines_is_an_empty_scope():
    scope = machine_scope(table(), None)
    assert scope == MachineScope(())
    assert not scope.several


def test_the_workspace_answers_ahead_of_one_machine():
    scope = machine_scope(table("docker:a"), None, workspace=True)
    assert scope == MachineScope(("docker:a",), workspace=True)
    assert scope.several


def test_the_workspace_alone_is_one_row():
    scope = machine_scope(table(), None, workspace=True)
    assert scope == MachineScope((), workspace=True)
    assert not scope.several


def test_mirage_names_the_workspace_only_where_it_answers():
    processes = table("docker:a")
    assert machine_scope(processes, "mirage", workspace=True) == MachineScope(
        (), True, True
    )
    assert machine_scope(processes, "mirage") is None


def test_a_process_search_takes_mirage_as_mirages_own():
    processes = table("docker:a")
    assert process_scope(processes, "mirage") == MachineScope((), True, True)
    assert process_scope(processes, "a") == MachineScope(("docker:a",), True)
    assert process_scope(processes, "nosuch") is None


def test_mirages_own_is_in_scope_unless_another_machine_is_picked():
    assert in_scope(MachineScope(("docker:a",)), "mirage")
    assert in_scope(MachineScope(("docker:a",)), "docker:a")
    assert not in_scope(MachineScope(("docker:a",), True), "mirage")
    assert in_scope(MachineScope((), True, True), "mirage")
    assert not in_scope(MachineScope((), True, True), "docker:a")


def test_options_may_follow_operands():
    parse = permuted_options(SHELL_SPECS["pgrep"], ["sleep", "-c", "-f"])
    assert parse.operands == ["sleep"]
    assert parse.flags["c"] is True and parse.flags["f"] is True


def test_words_after_a_double_dash_are_operands():
    parse = permuted_options(
        SHELL_SPECS["killall"], ["--", "sleep", "--signal", "KILL"]
    )
    assert parse.operands == ["sleep", "--signal", "KILL"]
    assert "s" not in parse.flags
    parse = permuted_options(SHELL_SPECS["pgrep"], ["sleep", "--", "-c"])
    assert parse.operands == ["sleep", "-c"]
    assert "c" not in parse.flags


def test_a_double_dash_an_option_takes_is_its_value():
    parse = permuted_options(SHELL_SPECS["pgrep"], ["-d", "--", "sleep", "-c"])
    assert parse.operands == ["sleep"]
    assert parse.flags["d"] == "--" and parse.flags["c"] is True


def test_option_refusal_names_the_option():
    parse = permuted_options(SHELL_SPECS["top"], ["-Z"])
    assert option_refusal("top", parse, page=False) == (
        "top: invalid option -- 'Z'\n"
    )


def test_with_machine_pads_to_the_columns():
    assert with_machine("ab  ", "m", 6) == "ab      m"


@pytest.mark.asyncio
async def test_a_later_error_is_told_once_after_what_stderr_holds():
    down = "free: e2b:down: machine did not answer\n"
    gone = "free: e2b:gone: machine did not answer\n"
    cut = "free: output truncated\n"
    node = ExecutionNode(command="free", stderr=down.encode())
    io = IOResult(stderr=(down + cut).encode())
    await tell_once(io, node, down + gone)
    await tell_once(io, node, gone)
    assert io.stderr == (down + cut + gone).encode()
    assert node.stderr == (down + gone).encode()
    assert io.exit_code == node.exit_code == 1
