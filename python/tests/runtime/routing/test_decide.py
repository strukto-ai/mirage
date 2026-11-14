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

from mirage.runtime import table
from mirage.runtime.base import Runtime
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.routing import runtime_for_script
from mirage.runtime.types import Program, RunResult
from mirage.runtime.workspace import WorkspaceRuntime


class AlphaRuntime(Runtime):
    name = "alpha"
    captures = ("python3", "python")

    async def run(self, engine, paths, texts, ctx) -> RunResult:
        return RunResult(stdout=b"alpha\n", stderr=None, exit_code=0)


class NodeRuntime(JsRuntime):
    name = "node-engine"
    captures = ("node",)

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class OtherNodeRuntime(NodeRuntime):
    name = "other-node"


class InProcessPy(PythonRuntime):
    name = "in-process-py"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_runtime_for_script_picks_by_machine_and_language():
    monty, local, py = MontyRuntime(), LocalRuntime(), InProcessPy()
    world = [monty, local, py]
    assert runtime_for_script(world, "worker", None, "python") is monty
    assert runtime_for_script(world, "host", None, "python") is local
    assert runtime_for_script(world, "in_process", None, "python") is py


def test_runtime_for_script_is_first_match_or_the_named_runtime(monkeypatch):
    monkeypatch.setitem(table.NAMED, "other-node", OtherNodeRuntime)
    node, other = NodeRuntime(), OtherNodeRuntime()
    world = [node, other]
    assert runtime_for_script(world, "in_process", None, "js") is node
    assert runtime_for_script(world, "in_process", "other-node", "js") is other
    assert runtime_for_script(world, "in_process", "quickjs", "js") is None


def test_runtime_for_script_has_no_cross_language_fallback():
    # A python program cannot run on a js engine. Captures do not count
    # either (alpha captures python3 but declares no language), and an
    # empty world selects nothing.
    assert (
        runtime_for_script([NodeRuntime()], "in_process", None, "python")
        is None
    )
    assert (
        runtime_for_script(
            [AlphaRuntime(), WorkspaceRuntime()], "in_process", None, "python"
        )
        is None
    )
    assert runtime_for_script([], "in_process", None, "js") is None
    assert runtime_for_script([MontyRuntime()], "host", None, "python") is None
