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
from mirage.runtime.routing import RouteContext, RouteError


def _line(line: str) -> RouteContext:
    return RouteContext(
        line=line,
        commands=(),
        command=line.split()[0],
        builtin=False,
        cwd="/",
        env={},
        session_id="",
        agent_id="",
        mounts=(),
    )


@pytest.mark.asyncio
async def test_a_route_verdict_is_a_placement_answer():
    def route(ctx: RouteContext):
        if "heavy" in ctx.line:
            return "beta"
        if "secret" in ctx.line:
            return {"deny": "secrets stay put"}
        return None

    policy = PlacementPolicy(route, [])
    assert await policy.pre_execute(_line("python3 heavy")) == Route("beta")
    assert await policy.pre_execute(_line("cat secret")) == Deny(
        "secrets stay put"
    )
    assert await policy.pre_execute(_line("echo hi")) is None
    # A mistake in the route policy is the deployment's, not a refusal.
    with pytest.raises(RouteError, match="unknown policy verdict keys"):
        await PlacementPolicy(lambda ctx: {"runtme": "x"}, []).pre_execute(
            _line("echo hi")
        )
