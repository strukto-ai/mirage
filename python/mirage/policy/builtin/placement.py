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

import inspect
from collections.abc import Awaitable, Callable

from mirage.policy.base import Policy
from mirage.policy.profile import ProfilePolicy, compile_program
from mirage.policy.script import ScriptPolicy
from mirage.policy.types import Action, ProfileScript, Route, RouteContext
from mirage.runtime.routing.errors import RouteError
from mirage.runtime.routing.types import RoutePolicy, RouteVerdict


class PlacementPolicy(Policy):
    """The workspace's ``route_policy``, answering at ``pre_execute``.

    The workspace compiles the configured callable or program into this
    built-in (``Policies.place``), so a route is one more
    ``pre_execute`` answer. A callable answers a runtime name (a Route)
    or None (silence). A program, ``{script, runtime}``, runs as a
    profile's policy programs run and prints what a ``pre_execute``
    program may answer. A mistake in either (any other answer, a
    program that fails) raises ``RouteError`` to the caller rather than
    failing closed, since a misconfigured route policy is the
    deployment's to fix and not a refusal to show an agent.

    Args:
        route (RoutePolicy): the configured callable or program.
        programs (ScriptPolicy): the workspace's program runner, which a
            program runs on.

    Raises:
        TypeError: the route is a string: a path is the workspace
            yaml's, which loads the program it names.
        ValueError: the program is not ``{script, runtime}``, or its
            script is still a path.
    """

    def __init__(self, route: RoutePolicy, programs: ScriptPolicy) -> None:
        if isinstance(route, str):
            raise TypeError(
                "route_policy must be a callable taking the RouteContext "
                "or {script, runtime}; a path is the workspace yaml's"
            )
        self._programs = programs
        self._call: (
            Callable[[RouteContext], RouteVerdict | Awaitable[RouteVerdict]]
            | None
        ) = None
        self._program: ProfileScript | None = None
        if callable(route):
            self._call = route
            return
        program = (
            route
            if isinstance(route, ProfilePolicy)
            else ProfilePolicy.model_validate(route)
        )
        try:
            self._program = compile_program(program, "")
        except ValueError as exc:
            raise ValueError(f"route_policy {exc}") from exc

    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        if self._program is not None:
            try:
                return await self._programs.run(
                    self._program, "pre_execute", ctx
                )
            except ValueError as exc:
                raise RouteError(f"route_policy {exc}") from exc
        assert self._call is not None
        called = self._call(ctx)
        verdict = await called if inspect.isawaitable(called) else called
        if verdict is None:
            return None
        if isinstance(verdict, str) and verdict:
            return Route(verdict)
        raise RouteError(
            f"route policy must answer a runtime name or None, got {verdict!r}"
        )
