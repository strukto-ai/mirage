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

from mirage.runtime.types import EvalResult, RunArgs


def test_run_args_defaults():
    args = RunArgs(code="x")
    assert args.args == []
    assert args.env == {}
    assert args.stdin is None
    assert args.flags == {}


def test_eval_result_defaults():
    result = EvalResult()
    assert result.value is None
    assert result.stdout == b""
    assert result.stderr is None
    assert result.exit_code == 0
    assert result.status == "complete"
