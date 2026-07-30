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
from typing import Any

from mirage.runtime.base import EvalError, EvaluatorMixin, EvalValue, Runtime
from mirage.runtime.route.types import (RouteContext, RouteFn, RouteScript,
                                        RoutingDecision, ScriptSource)
from mirage.runtime.table import bind_commands, catch_all, runtime_bindings_for


def evaluator_of(entries: list[Runtime]) -> EvaluatorMixin | None:
    """The world's policy engine: its first evaluator-capable entry.

    Config-borne route scripts run on it; any runtime inheriting
    EvaluatorMixin qualifies (monty in the default world, or a user
    runtime in any language). None when the world has no evaluator,
    which only matters once a ScriptSource actually needs one.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
    """
    for entry in entries:
        if isinstance(entry, EvaluatorMixin):
            return entry
    return None


async def _eval_source(source: str, ctx_payload: dict[str, EvalValue],
                       evaluator: EvaluatorMixin | None) -> EvalValue:
    """Evaluate a config script on the world's evaluator.

    The script sees the ctx payload as the `ctx` global and its LAST
    EXPRESSION is the verdict; the script's language is the
    evaluator's language.

    Args:
        source (str): the script program.
        ctx_payload (dict[str, EvalValue]): the RouteContext payload.
        evaluator (EvaluatorMixin | None): the world's policy engine.

    Raises:
        ValueError: no evaluator in the world, or the script does not
            parse or raises.
    """
    if evaluator is None:
        raise ValueError(
            "route scripts need an evaluator runtime in the workspace "
            "(install with: pip install mirage-ai[monty], or use a "
            "Python callable instead)")
    try:
        result = await evaluator.eval(source, inputs={"ctx": ctx_payload})
    except EvalError as exc:
        prefix = ("route script syntax error: "
                  if exc.syntax else "route script failed: ")
        raise ValueError(prefix + str(exc))
    return result.value


async def evaluate_script(script: RouteScript, ctx: RouteContext,
                          runtime: Runtime,
                          evaluator: EvaluatorMixin | None) -> bool:
    """Ask one runtime's script whether it wants the line.

    The script sees the runtime's own view of the context
    (RouteContext.for_runtime): ``command`` is its first captured
    stage, plus ``runtime`` identity in the script payload.

    Args:
        script (RouteScript): a callable taking the RouteContext, or
            a config-borne ScriptSource.
        ctx (RouteContext): facts about the line.
        runtime (Runtime): the runtime being asked (ctx.runtime).
        evaluator (EvaluatorMixin | None): the world's policy engine,
            consulted only for ScriptSource scripts.
    """
    view = ctx.for_runtime(runtime)
    verdict: Any
    if isinstance(script, ScriptSource):
        verdict = await _eval_source(script.source, view.to_dict(runtime),
                                     evaluator)
    else:
        verdict = script(view)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    return bool(verdict)


async def evaluate_route(route: RouteFn, ctx: RouteContext,
                         evaluator: EvaluatorMixin | None) -> str | None:
    """Run the global route, returning a runtime name or None to pass.

    Args:
        route (RouteFn): a callable taking the RouteContext, or a
            config-borne ScriptSource (last expression = the name).
        ctx (RouteContext): facts about the line.
        evaluator (EvaluatorMixin | None): the world's policy engine,
            consulted only for ScriptSource routes.

    Raises:
        ValueError: the route returned something other than a runtime
            name or None.
    """
    verdict: Any
    if isinstance(route, ScriptSource):
        verdict = await _eval_source(route.source, ctx.to_dict(), evaluator)
    else:
        verdict = route(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if verdict is None or isinstance(verdict, str):
        return verdict
    raise ValueError(f"route must return a runtime name or None, "
                     f"got {verdict!r}")


async def decide_line(entries: list[Runtime], route: RouteFn | None,
                      ctx: RouteContext,
                      static_bindings: dict[str, Runtime]) -> RoutingDecision:
    """Resolve the routing ladder for one line: route, then scripts.

    A route verdict overlays the named runtime's captures on the
    static bindings (an affirmative choice, never a refusal). With no
    verdict, per-runtime scripts filter the entry list: an entry with
    no script is always willing, and the willing entries re-bind in
    list order. The vfs runtime is filtered exactly like the others;
    a command left without a willing runtime is an admission failure
    at dispatch. Config-borne scripts run on the world's evaluator
    (evaluator_of), never on a hardcoded interpreter.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        route (RouteFn | None): the global route, if configured.
        ctx (RouteContext): facts about the line.
        static_bindings (dict[str, Runtime]): the workspace's static
            command bindings.
    """
    evaluator = evaluator_of(entries)
    if route is not None:
        name = await evaluate_route(route, ctx, evaluator)
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
            entry.script, ctx, entry, evaluator))
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
