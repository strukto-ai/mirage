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

import pytest

from mirage.runtime.base import (EvalError, EvalResult, EvaluatorMixin,
                                 RunArgs, RunResult, Runtime)
from mirage.runtime.config import RuntimeConfig


class EchoRuntime(Runtime):
    name = "echo"
    captures = ("echo-run", )

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=args.code.encode(), stderr=None, exit_code=0)


def test_run_args_defaults():
    args = RunArgs(code="x")
    assert args.args == []
    assert args.env == {}
    assert args.stdin is None
    assert args.flags == {}


def test_attach_defaults_to_noop():
    rt = EchoRuntime()
    rt.attach(lambda *a: None, lambda: [])
    result = asyncio.run(rt.run(RunArgs(code="hi")))
    assert result.stdout == b"hi"
    assert result.exit_code == 0


def test_close_defaults_to_noop():
    asyncio.run(EchoRuntime().close())


def test_uniform_constructor_defaults():
    rt = EchoRuntime()
    assert rt.captures == ("echo-run", )
    assert rt.config == RuntimeConfig()
    assert rt.script is None


def test_captures_override():
    rt = EchoRuntime(captures=["only-this"])
    assert rt.captures == ("only-this", )


def test_script_stored():

    def wants(ctx):
        return True

    rt = EchoRuntime(script=wants)
    assert rt.script is wants


def test_unknown_config_key_fails_loud():
    with pytest.raises(TypeError):
        EchoRuntime(config={"no_such_knob": 1})


def test_eval_result_defaults():
    result = EvalResult()
    assert result.value is None
    assert result.stdout == b""
    assert result.stderr is None
    assert result.status == "complete"


def test_eval_error_carries_the_syntax_bit():
    assert EvalError("boom").syntax is False
    assert EvalError("boom", syntax=True).syntax is True


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
