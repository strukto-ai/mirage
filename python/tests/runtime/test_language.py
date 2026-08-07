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

import asyncio

from mirage.runtime.js.base import JsRuntime
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime
from mirage.runtime.types import RunArgs, RunResult


class EchoRuntime(PythonRuntime):
    name = "echo"
    captures = ("echo-run", )

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=args.code.encode(), stderr=None, exit_code=0)


def test_attach_defaults_to_noop():
    rt = EchoRuntime()
    rt.attach(lambda *a: None, lambda: [])
    result = asyncio.run(rt.run(RunArgs(code="hi")))
    assert result.stdout == b"hi"
    assert result.exit_code == 0


def test_language_is_declared_once_per_tier():
    # Concrete engines inherit the tier's language instead of each
    # declaring its own, so run and eval can never disagree per class.
    assert PythonRuntime.language == "python"
    assert JsRuntime.language == "js"
    for cls in (MontyRuntime, WasiRuntime, LocalRuntime):
        assert issubclass(cls, PythonRuntime)
        assert cls.language == "python"
    assert issubclass(QuickJsRuntime, JsRuntime)
    assert QuickJsRuntime.language == "js"


def test_tiers_are_language_runtimes():
    assert issubclass(PythonRuntime, LanguageRuntime)
    assert issubclass(JsRuntime, LanguageRuntime)
