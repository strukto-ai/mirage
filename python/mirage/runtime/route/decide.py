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
from collections.abc import Mapping
from typing import Any

from mirage.policy.errors import PolicyError
from mirage.policy.types import Deny, ExecuteContext, Route
from mirage.runtime.base import Runtime
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.route.types import (PolicyDecision, PolicyScript,
                                        ScriptSource)
from mirage.runtime.table import bind_commands, catch_all
from mirage.runtime.types import EvalValue

POLICY_EVAL_TIMEOUT_SECONDS = 10.0


def evaluator_of(entries: list[Runtime],
                 language: str | None = None) -> EvaluatorMixin | None:
    """The world's policy engine for a script.

    Config-borne policy scripts run on it; any runtime inheriting
    EvaluatorMixin qualifies (monty in the default world, or a user
    runtime in any language). The first evaluator whose eval_language
    matches the script's language wins, so a .js policy runs on
    quickjs even when a python evaluator sits earlier in the world;
    with no language (or no match) the first evaluator serves. None
    when the world has no evaluator, which only matters once a
    ScriptSource actually needs one.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        language (str | None): the script's language, if known.
    """
    first: EvaluatorMixin | None = None
    for entry in entries:
        if isinstance(entry, EvaluatorMixin):
            if first is None:
                first = entry
            if language is not None and entry.eval_language == language:
                return entry
    return first


async def eval_source(source: str, ctx_payload: dict[str, EvalValue],
                      evaluator: EvaluatorMixin | None) -> EvalValue:
    """Evaluate a config script on the world's evaluator.

    The script sees the ctx payload as the `ctx` global and its LAST
    EXPRESSION is the verdict; the script's language is the
    evaluator's language.

    Args:
        source (str): the script program.
        ctx_payload (dict[str, EvalValue]): the ExecuteContext payload.
        evaluator (EvaluatorMixin | None): the world's policy engine.

    Raises:
        PolicyError: no evaluator in the world, the script times out,
            or it does not parse or raises.
    """
    if evaluator is None:
        raise PolicyError(
            "policy scripts need an evaluator runtime in the workspace "
            "(install with: pip install mirage-ai[monty], or use a "
            "Python callable instead)")
    try:
        result = await asyncio.wait_for(evaluator.eval(
            source, inputs={"ctx": ctx_payload}),
                                        timeout=POLICY_EVAL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise PolicyError(f"policy script timed out after "
                          f"{POLICY_EVAL_TIMEOUT_SECONDS:g}s") from exc
    except EvalError as exc:
        prefix = ("policy script syntax error: "
                  if exc.syntax else "policy script failed: ")
        raise PolicyError(prefix + str(exc))
    return result.value


async def evaluate_script(script: PolicyScript, ctx: ExecuteContext,
                          runtime: Runtime, entries: list[Runtime]) -> bool:
    """Ask one runtime's script whether it wants the line.

    The script sees the runtime's own view of the context
    (ExecuteContext.for_runtime): ``command`` is its first captured
    stage, plus ``runtime`` identity in the script payload.

    Args:
        script (PolicyScript): a callable taking the ExecuteContext, or
            a config-borne ScriptSource.
        ctx (ExecuteContext): the parse context for the line.
        runtime (Runtime): the runtime being asked (ctx.runtime).
        entries (list[Runtime]): the workspace's ordered world; a
            ScriptSource selects its evaluator from it by language.

    Raises:
        PolicyError: the script answered with a policy verdict shape
            (a dict or an Action arm) instead of a boolean; a
            deny-dict is truthy, so coercing it would mean "willing",
            the opposite of intent.
    """
    view = ctx.for_runtime(runtime)
    verdict: Any
    if isinstance(script, ScriptSource):
        verdict = await eval_source(script.source, view.to_dict(runtime),
                                    evaluator_of(entries, script.language))
    else:
        verdict = script(view)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if isinstance(verdict, (Mapping, Route, Deny)):
        raise PolicyError(
            f"entry scripts answer a boolean (deny and placement belong "
            f"to the routing policy), got {verdict!r} from {runtime.name!r}")
    return bool(verdict)


async def decide_line(entries: list[Runtime],
                      ctx: ExecuteContext) -> PolicyDecision:
    """Resolve entry-script willingness for one line.

    Per-runtime scripts filter the entry list: an entry with no script
    is always willing, and the willing entries re-bind in list order.
    The vfs runtime is filtered exactly like the others; a command left
    without a willing runtime is an admission failure at dispatch.
    Config-borne scripts run on the world's evaluator (evaluator_of),
    never on a hardcoded interpreter. Routing verdicts do not live
    here: the ``policy=`` script fires earlier, as the RoutingPolicy
    built-in on the pre_execute hook.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        ctx (ExecuteContext): the parse context for the line.
    """
    willing: list[Runtime] = []
    for entry in entries:
        wants = (True if entry.script is None else await evaluate_script(
            entry.script, ctx, entry, entries))
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
    return PolicyDecision(bindings=bindings, fallback=catch_all(willing))
