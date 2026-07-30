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
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.types import EvalResult, RunArgs, RunResult


class PlainRuntime(Runtime):
    name = "plain"

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class EvalingRuntime(Runtime, EvaluatorMixin):
    name = "evaling"

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def eval(self, code, *, inputs=None, session=None) -> EvalResult:
        return EvalResult(value=code)


def test_evaluator_mixin_is_a_type_level_capability():
    assert not isinstance(PlainRuntime(), EvaluatorMixin)
    assert isinstance(EvalingRuntime(), EvaluatorMixin)
