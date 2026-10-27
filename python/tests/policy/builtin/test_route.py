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

import pytest

from mirage.policy import Deny, Route
from mirage.policy.builtin.route import RoutePolicy
from mirage.policy.script import ScriptPolicy
from mirage.policy.types import RouteContext
from mirage.runtime.routing import RouteError
from mirage.runtime.types import ScriptSource


class NoPrograms:
    """A sessions query whose profiles name no program."""

    def scripts_of(self, session_id: str) -> dict:
        return {}


def _line(line: str) -> RouteContext:
    return RouteContext(
        line=line,
        commands=(),
        session_id="",
    )


def _heavy_on_beta(ctx: RouteContext) -> str | None:
    return "beta" if "heavy" in ctx.line else None


def _route_policy(route) -> RoutePolicy:
    return RoutePolicy(route, ScriptPolicy(NoPrograms()))


@pytest.mark.asyncio
async def test_a_runtime_name_places_the_line_and_none_says_nothing():
    policy = _route_policy(_heavy_on_beta)
    assert await policy.pre_execute(_line("python3 heavy")) == Route("beta")
    assert await policy.pre_execute(_line("echo hi")) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "verdict",
    ["", {"route": "beta"}, {"deny": "no"}, Route("beta"), Deny("no"), 42],
)
async def test_anything_but_a_name_or_none_is_the_deployments_mistake(
    verdict,
):
    # Refusing a line is a policy's answer, not the router's; a route
    # policy that answers anything else is misconfigured, not a refusal.
    with pytest.raises(RouteError, match="a runtime name or None"):
        await _route_policy(lambda ctx: verdict).pre_execute(_line("echo hi"))


ROUTE_HEAVY = """
import json
import os

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if "heavy" in ctx["line"]:
    print(json.dumps({"kind": "route", "runtime": "beta"}))
"""


@pytest.mark.asyncio
async def test_a_program_prints_its_route_or_nothing():
    policy = _route_policy(
        {"script": ScriptSource(ROUTE_HEAVY), "runtime": "monty"}
    )
    assert await policy.pre_execute(_line("python3 heavy")) == Route("beta")
    assert await policy.pre_execute(_line("echo hi")) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "refusal"),
    [
        ("1 / 0", "route_policy exited 1"),
        ("print('beta')", "route_policy must print a JSON answer"),
    ],
)
async def test_a_program_that_fails_is_the_deployments_mistake(
    source, refusal
):
    policy = _route_policy(
        {"script": ScriptSource(source), "runtime": "monty"}
    )
    with pytest.raises(RouteError, match=refusal):
        await policy.pre_execute(_line("echo hi"))


def test_a_path_is_the_yamls_to_load():
    with pytest.raises(TypeError, match="a path is the workspace yaml's"):
        _route_policy("route.py")
    with pytest.raises(
        ValueError, match="route_policy names a policy by path"
    ):
        _route_policy({"script": "route.py", "runtime": "monty"})
