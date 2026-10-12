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

from mirage.policy.script import script_context
from mirage.policy.types import Ask, Deny, Route, RouteContext
from mirage.runtime.base import Runtime
from mirage.runtime.constants import SCRIPT_EVAL_TIMEOUT_SECONDS
from mirage.runtime.errors import EvalError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.routing.errors import RouteError
from mirage.runtime.routing.types import (
    RouteDecision,
    RoutePolicy,
    RouteScript,
    RouteVerdict,
)
from mirage.runtime.script import eval_with_ctx
from mirage.runtime.table import bind_commands, catch_all
from mirage.runtime.types import EvalValue, Language, ScriptSource


def evaluator_of(
    entries: list[Runtime], language: Language | None = None
) -> EvaluatorMixin | None:
    """The world's policy engine for a script.

    Config-borne policy scripts run on it; any runtime inheriting
    EvaluatorMixin qualifies (monty in the default world, or a user
    runtime in any language). The first evaluator whose ``language``
    matches the script's wins, so a .js policy runs on quickjs even
    when a python evaluator sits earlier in the world; with no
    language (or no match) the first evaluator serves. None when the
    world has no evaluator, which only matters once a ScriptSource
    actually needs one. The attribute read here is the one ``run``
    answers for too (LanguageRuntime.language), so an engine cannot
    speak one language at this entry point and another at that one.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        language (Language | None): the script's language, if known.
    """
    first: EvaluatorMixin | None = None
    for entry in entries:
        if isinstance(entry, EvaluatorMixin):
            if first is None:
                first = entry
            if (
                language is not None
                and isinstance(entry, LanguageRuntime)
                and entry.language == language
            ):
                return entry
    return first


def runtime_for_language(
    entries: list[Runtime], language: Language
) -> LanguageRuntime | None:
    """The world's interpreter for a script CLI, evaluator_of's run twin.

    The first entry whose ``run`` speaks the language wins, the same
    first-match rule. Unlike evaluator_of there is no any-language
    fallback: a python program cannot run on a js engine, so no match
    means None and the caller reports the world's entries.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        language (Language): the script's language ("python" or "js").
    """
    return next(
        (
            entry
            for entry in entries
            if isinstance(entry, LanguageRuntime)
            and entry.language == language
        ),
        None,
    )


async def _eval_source(
    source: str,
    ctx_payload: dict[str, EvalValue],
    evaluator: EvaluatorMixin | None,
) -> EvalValue:
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
            "policy scripts need an evaluator runtime in the workspace "
            "(install with: pip install mirage-ai[monty], or use a "
            "Python callable instead)"
        )
    try:
        return await eval_with_ctx(
            source, ctx_payload, evaluator, SCRIPT_EVAL_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError as exc:
        raise RouteError(
            f"policy script timed out after {SCRIPT_EVAL_TIMEOUT_SECONDS:g}s"
        ) from exc
    except EvalError as exc:
        prefix = (
            "policy script syntax error: "
            if exc.syntax
            else "policy script failed: "
        )
        raise ValueError(prefix + str(exc))


async def evaluate_script(
    script: RouteScript,
    ctx: RouteContext,
    runtime: Runtime,
    entries: list[Runtime],
) -> bool:
    """Ask one runtime's script whether it wants the line.

    The script sees the line's context with ``runtime`` added (its name
    and captures), so it can find the commands it would serve.

    Args:
        script (RouteScript): a callable taking the RouteContext, or
            a config-borne ScriptSource.
        ctx (RouteContext): the line's context.
        runtime (Runtime): the runtime being asked.
        entries (list[Runtime]): the workspace's ordered world; a
            ScriptSource selects its evaluator from it by language.

    Raises:
        RouteError: the script answered with a policy answer (a dict or
            a Route, Deny or Ask) instead of a boolean; a deny-dict is
            truthy, so coercing it would mean "willing", the opposite of
            intent.
    """
    verdict: Any
    if isinstance(script, ScriptSource):
        verdict = await _eval_source(
            script.source,
            {
                **script_context(ctx),
                "runtime": {
                    "name": runtime.name,
                    "captures": list(runtime.captures),
                },
            },
            evaluator_of(entries, script.language),
        )
    else:
        verdict = script(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if isinstance(verdict, (Mapping, Route, Deny, Ask)):
        raise RouteError(
            f"entry scripts answer a boolean (placement is the route "
            f"policy's, refusal a policy's), got {verdict!r} from "
            f"{runtime.name!r}"
        )
    return bool(verdict)


async def evaluate_policy(
    policy: RoutePolicy, ctx: RouteContext, entries: list[Runtime]
) -> RouteVerdict | EvalValue:
    """Run the route policy and return what it answered, unread.

    Args:
        policy (RoutePolicy): a callable taking the RouteContext, or a
            config-borne ScriptSource (last expression = the verdict).
        ctx (RouteContext): the line's context.
        entries (list[Runtime]): the workspace's ordered world; a
            ScriptSource selects its evaluator from it by language.
    """
    if isinstance(policy, ScriptSource):
        return await _eval_source(
            policy.source,
            script_context(ctx),
            evaluator_of(entries, policy.language),
        )
    verdict = policy(ctx)
    if inspect.isawaitable(verdict):
        verdict = await verdict
    return verdict


async def decide_line(
    entries: list[Runtime],
    ctx: RouteContext,
) -> RouteDecision[Runtime]:
    """The runtimes' own scripts' decision, for a line no policy placed.

    Each runtime's script filters the entry list: an entry with no
    script is always willing, and the willing entries re-bind in list
    order. The workspace runtime is filtered exactly like the others; a
    command left without a willing runtime is an admission failure at
    dispatch. Config-borne scripts run on the world's evaluator
    (evaluator_of), never on a hardcoded interpreter.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        ctx (RouteContext): the line's context.
    """
    willing: list[Runtime] = []
    for entry in entries:
        wants = (
            True
            if entry.script is None
            else await evaluate_script(entry.script, ctx, entry, entries)
        )
        if wants:
            willing.append(entry)
    # Every captured command resolves: to its first willing capturer,
    # or to None (all capturers refused -> admission failure).
    bindings: dict[str, Runtime | None] = {
        command: None for entry in entries for command in entry.captures
    }
    bindings.update(bind_commands(willing))
    return RouteDecision(bindings=bindings, fallback=catch_all(willing))
