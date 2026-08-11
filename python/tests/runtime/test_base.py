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

from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin, LineExecutorMixin


class MarkerRuntime(Runtime):
    name = "marker"
    captures = ("echo-run", )


def test_base_carries_no_capability_doors():
    # The base holds identity and config only; run, run_line, eval and
    # attach belong to the tiers and mixins, detected by isinstance.
    rt = MarkerRuntime()
    assert not hasattr(rt, "run")
    assert not hasattr(rt, "run_line")
    assert not hasattr(rt, "attach")
    assert not isinstance(rt, LanguageRuntime)
    assert not isinstance(rt, LineExecutorMixin)
    assert not isinstance(rt, EvaluatorMixin)


def test_close_defaults_to_noop():
    asyncio.run(MarkerRuntime().close())


def test_uniform_constructor_defaults():
    rt = MarkerRuntime()
    assert rt.captures == ("echo-run", )
    assert rt.config == RuntimeConfig()
    assert rt.script is None


def test_captures_override():
    rt = MarkerRuntime(captures=["only-this"])
    assert rt.captures == ("only-this", )


def test_script_stored():

    def wants(ctx):
        return True

    rt = MarkerRuntime(script=wants)
    assert rt.script is wants


def test_unknown_config_key_fails_loud():
    with pytest.raises(TypeError):
        MarkerRuntime(config={"no_such_knob": 1})
