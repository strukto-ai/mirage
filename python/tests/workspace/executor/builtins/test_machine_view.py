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

from mirage.commands.spec.shell import SHELL_SPECS
from mirage.execution.process.table import ProcessTable
from mirage.workspace.executor.builtins.machine_view import (
    MachineScope,
    machine_scope,
    option_refusal,
    permuted_options,
    with_machine,
)


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


def test_options_may_follow_operands():
    parse = permuted_options(SHELL_SPECS["pgrep"], ["sleep", "-c", "-f"])
    assert parse.operands == ["sleep"]
    assert parse.flags["c"] is True and parse.flags["f"] is True


def test_option_refusal_names_the_option():
    parse = permuted_options(SHELL_SPECS["top"], ["-Z"])
    assert option_refusal("top", parse, page=False) == (
        "top: invalid option -- 'Z'\n"
    )


def test_with_machine_pads_to_the_columns():
    assert with_machine("ab  ", "m", 6) == "ab      m"
