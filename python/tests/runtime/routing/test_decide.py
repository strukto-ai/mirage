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

from mirage.runtime.base import Runtime
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.routing import runtime_for_language
from mirage.runtime.types import RunArgs, RunResult
from mirage.runtime.workspace import WorkspaceRuntime


class AlphaRuntime(Runtime):
    name = "alpha"
    captures = ("python3", "python")

    async def run(self, args: RunArgs, context=None) -> RunResult:
        return RunResult(stdout=b"alpha\n", stderr=None, exit_code=0)


class NodeRuntime(JsRuntime):
    name = "node-engine"
    captures = ("node",)

    async def run(self, args: RunArgs, context=None) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_runtime_for_language_is_first_match_wins():
    monty, local, js = MontyRuntime(), LocalRuntime(), NodeRuntime()
    assert runtime_for_language([monty, local, js], "python") is monty
    assert runtime_for_language([local, monty, js], "python") is local
    assert runtime_for_language([monty, js], "js") is js


def test_runtime_for_language_has_no_cross_language_fallback():
    # A python program cannot run on a js engine. Captures do not count
    # either (alpha captures python3 but declares no language), and an
    # empty world selects nothing.
    assert runtime_for_language([NodeRuntime()], "python") is None
    assert (
        runtime_for_language([AlphaRuntime(), WorkspaceRuntime()], "python")
        is None
    )
    assert runtime_for_language([], "js") is None
