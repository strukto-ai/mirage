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

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.pin import (current_line_routing, push_line_routing,
                                reset_line_routing)
from mirage.runtime.route import LineRouting


class FakeRuntime(Runtime):
    name = "fake"
    captures = ("python3", )

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_default_is_none():
    assert current_line_routing() is None


def test_push_and_reset_restore_prior_state():
    routing = LineRouting(bindings={"python3": FakeRuntime()})
    token = push_line_routing(routing)
    assert current_line_routing() is routing
    reset_line_routing(token)
    assert current_line_routing() is None


@pytest.mark.asyncio
async def test_routing_is_task_scoped():
    routing = LineRouting(bindings={"python3": FakeRuntime()})
    token = push_line_routing(routing)
    try:
        # A freshly spawned task copies the context, so it sees the
        # decision; an independent line pushes its own before running.
        seen = await asyncio.create_task(_read_current())
        assert seen is routing
    finally:
        reset_line_routing(token)


async def _read_current():
    return current_line_routing()
