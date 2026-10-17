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

from mirage.commands.config import Context
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin


class MarkerRuntime(Runtime):
    name = "marker"
    captures = ("echo-run",)


def test_base_carries_no_capability_entry_points():
    # The base holds identity and config only; code, run_line and attach
    # belong to the tiers and mixins, detected by isinstance.
    rt = MarkerRuntime()
    with pytest.raises(UnsupportedExecutionError, match="code execution"):
        asyncio.run(rt.execute([], [], Context()))
    assert not hasattr(rt, "run_line")
    assert not hasattr(rt, "attach")
    assert not isinstance(rt, LanguageRuntime)
    assert not isinstance(rt, LineExecutorMixin)


def test_close_defaults_to_noop():
    asyncio.run(MarkerRuntime().close())


def test_uniform_constructor_defaults():
    rt = MarkerRuntime()
    assert rt.captures == ("echo-run",)
    assert rt.config == RuntimeConfig()


def test_captures_override():
    rt = MarkerRuntime(captures=["only-this"])
    assert rt.captures == ("only-this",)


def test_unknown_config_key_fails_loud():
    with pytest.raises(TypeError):
        MarkerRuntime(config={"no_such_knob": 1})


def test_reach_defaults_to_process():
    # A runtime that declares nothing gets the no-promise claim: it
    # may act around the workspace gate. Only an explicit "workspace"
    # narrows it.
    assert MarkerRuntime().reach == "process"
