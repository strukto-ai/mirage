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
import inspect
from collections.abc import Callable
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.python.monty import _MirageOS, pydantic_monty
from mirage.runtime.route.types import (RouteContext, RouteFn, RouteScript,
                                        RoutingDecision, ScriptSource)
from mirage.runtime.table import bind_commands, catch_all, runtime_bindings_for


async def _eval_monty(source: str, ctx_payload: dict[str, Any],
                      dispatch: Callable[..., Any] | None) -> Any:
    """Evaluate a monty route script; its last expression is the verdict.

    The script sees the ctx payload as the `ctx` global and may open
    workspace files through the same bridge agent code uses.

    Args:
        source (str): monty source.
        ctx_payload (dict[str, Any]): the RouteContext payload.
        dispatch (Callable | None): workspace dispatch for file reads.

    Raises:
        ImportError: the monty extra is not installed.
        ValueError: the script does not parse or raises.
    """
    if pydantic_monty is None:
        raise ImportError(
            "route scripts run on monty; install with: pip install "
            "mirage-ai[monty], or use a Python callable instead")
    loop = asyncio.get_running_loop()
    bridge = _MirageOS(loop, dispatch, {})
    try:
        program = pydantic_monty.Monty(source, inputs=["ctx"])
    except pydantic_monty.MontySyntaxError as exc:
        raise ValueError("route script syntax error: " +
                         exc.display(format="traceback"))
    try:
        return await program.run_async(inputs={"ctx": ctx_payload}, os=bridge)
    except pydantic_monty.MontyRuntimeError as exc:
        raise ValueError("route script failed: " +
                         exc.display(format="traceback"))


async def evaluate_script(script: RouteScript, ctx: RouteContext,
                          runtime: Runtime,
                          dispatch: Callable[..., Any] | None) -> bool:
    """Ask one runtime's script whether it wants the line.

    The script sees the runtime's own view of the context
    (RouteContext.for_runtime): ``command`` is its first captured
    stage, plus ``runtime`` identity in the monty payload.

    Args:
        script (RouteScript): a callable taking the RouteContext, or
            a config-borne ScriptSource.
        ctx (RouteContext): facts about the line.
        runtime (Runtime): the runtime being asked (ctx.runtime).
        dispatch (Callable | None): workspace dispatch for file reads.
    """
    view = ctx.for_runtime(runtime)
    if isinstance(script, ScriptSource):
        verdict = await _eval_monty(script.source, view.to_dict(runtime),
                                    dispatch)
    else:
        verdict = script(view)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    return bool(verdict)


async def evaluate_route(route: RouteFn, ctx: RouteContext,
                         dispatch: Callable[..., Any] | None) -> str | None:
    """Run the global route, returning a runtime name or None to pass.

    Args:
        route (RouteFn): a callable taking the RouteContext, or a
            config-borne ScriptSource (last expression = the name).
        ctx (RouteContext): facts about the line.
        dispatch (Callable | None): workspace dispatch for file reads.

    Raises:
        ValueError: the route returned something other than a runtime
            name or None.
    """
    if isinstance(route, ScriptSource):
        verdict = await _eval_monty(route.source, ctx.to_dict(), dispatch)
    else:
        verdict = route(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if verdict is None or isinstance(verdict, str):
        return verdict
    raise ValueError(f"route must return a runtime name or None, "
                     f"got {verdict!r}")


async def decide_line(entries: list[Runtime], route: RouteFn | None,
                      ctx: RouteContext, static_bindings: dict[str, Runtime],
                      dispatch: Callable[..., Any] | None) -> RoutingDecision:
    """Resolve the routing ladder for one line: route, then scripts.

    A route verdict overlays the named runtime's captures on the
    static bindings (an affirmative choice, never a refusal). With no
    verdict, per-runtime scripts filter the entry list: an entry with
    no script is always willing, and the willing entries re-bind in
    list order. The vfs runtime is filtered exactly like the others;
    a command left without a willing runtime is an admission failure
    at dispatch.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        route (RouteFn | None): the global route, if configured.
        ctx (RouteContext): facts about the line.
        static_bindings (dict[str, Runtime]): the workspace's static
            command bindings.
        dispatch (Callable | None): workspace dispatch for file reads.
    """
    if route is not None:
        name = await evaluate_route(route, ctx, dispatch)
        if name is not None:
            overlay = runtime_bindings_for(entries, name)
            return RoutingDecision(bindings={
                **static_bindings,
                **overlay
            },
                                   fallback=catch_all(entries))
    willing: list[Runtime] = []
    for entry in entries:
        wants = (True if entry.script is None else await evaluate_script(
            entry.script, ctx, entry, dispatch))
        if wants:
            willing.append(entry)
    # Every captured command resolves: to its first willing capturer,
    # or to None (all capturers refused -> admission failure).
    bindings: dict[str, Runtime | None] = {
        command: None
        for entry in entries
        for command in entry.captures
    }
    bindings.update(bind_commands(willing))
    return RoutingDecision(bindings=bindings, fallback=catch_all(willing))
