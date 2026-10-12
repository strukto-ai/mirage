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
from mirage.policy.builtin.placement import PlacementPolicy
from mirage.policy.types import RouteContext
from mirage.runtime.routing import RouteError


def _line(line: str) -> RouteContext:
    return RouteContext(
        line=line,
        commands=(),
        session_id="",
        agent_id="",
    )


@pytest.mark.asyncio
async def test_a_runtime_name_places_the_line_and_none_says_nothing():
    def route(ctx: RouteContext):
        return "beta" if "heavy" in ctx.line else None

    policy = PlacementPolicy(route, list)
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
        await PlacementPolicy(lambda ctx: verdict, list).pre_execute(
            _line("echo hi")
        )
