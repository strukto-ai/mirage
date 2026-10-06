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

from collections.abc import Callable

from mirage.policy.base import Policy
from mirage.policy.types import Deny, Route
from mirage.runtime.base import Runtime
from mirage.runtime.routing.decide import evaluate_policy
from mirage.runtime.routing.errors import RouteDeny
from mirage.runtime.routing.types import RouteContext, RoutePolicy


class PlacementPolicy(Policy):
    """The workspace's ``route_policy``, answering at ``pre_execute``.

    The workspace compiles the configured callable or script into this
    built-in (``Policies.place``), so a route verdict is one more
    placement answer: a runtime
    name (``{"runtime": name}``, ``RouteResult``) is a Route, ``{"deny":
    reason}`` (``DenyResult``) a Deny, None silence. Its payload and its
    verdict shapes are the route policy's own. A mistake in it (an
    unknown verdict key, a script that does not parse) raises
    ``RouteError`` to the caller rather than failing closed, since a
    misconfigured route policy is the deployment's to fix and not a
    refusal to show an agent.

    Args:
        route (RoutePolicy): the configured callable or script.
        entries (Callable[[], list[Runtime]]): the workspace's ordered
            runtimes as they stand when a line is placed, which pick a
            script's evaluator.
    """

    def __init__(
        self, route: RoutePolicy, entries: Callable[[], list[Runtime]]
    ) -> None:
        self._route = route
        self._entries = entries

    async def pre_execute(self, ctx: RouteContext) -> Deny | Route | None:
        try:
            name = await evaluate_policy(self._route, ctx, self._entries())
        except RouteDeny as exc:
            return Deny(exc.reason)
        return None if name is None else Route(name)
