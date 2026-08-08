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

from mirage.runtime.base import Runtime
from mirage.runtime.errors import EvalError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.policy.errors import PolicyDeny, PolicyError
from mirage.runtime.policy.types import (DenyResult, PolicyContext,
                                         PolicyDecision, PolicyFn,
                                         PolicyResult, PolicyScript,
                                         RouteResult, ScriptSource)
from mirage.runtime.table import bind_commands, catch_all, runtime_bindings_for
from mirage.runtime.types import EvalValue, Language

POLICY_EVAL_TIMEOUT_SECONDS = 10.0


def evaluator_of(entries: list[Runtime],
                 language: Language | None = None) -> EvaluatorMixin | None:
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
    speak one language at this door and another at that one.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        language (Language | None): the script's language, if known.
    """
    first: EvaluatorMixin | None = None
    for entry in entries:
        if isinstance(entry, EvaluatorMixin):
            if first is None:
                first = entry
            if (language is not None and isinstance(entry, LanguageRuntime)
                    and entry.language == language):
                return entry
    return first


def runtime_for_language(entries: list[Runtime],
                         language: Language) -> LanguageRuntime | None:
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
        (entry for entry in entries
         if isinstance(entry, LanguageRuntime) and entry.language == language),
        None)


async def _eval_source(source: str, ctx_payload: dict[str, EvalValue],
                       evaluator: EvaluatorMixin | None) -> EvalValue:
    """Evaluate a config script on the world's evaluator.

    The script sees the ctx payload as the `ctx` global and its LAST
    EXPRESSION is the verdict; the script's language is the
    evaluator's language.

    Args:
        source (str): the script program.
        ctx_payload (dict[str, EvalValue]): the PolicyContext payload.
        evaluator (EvaluatorMixin | None): the world's policy engine.

    Raises:
        ValueError: no evaluator in the world, or the script does not
            parse or raises.
    """
    if evaluator is None:
        raise ValueError(
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
        raise ValueError(prefix + str(exc))
    return result.value


async def evaluate_script(script: PolicyScript, ctx: PolicyContext,
                          runtime: Runtime, entries: list[Runtime]) -> bool:
    """Ask one runtime's script whether it wants the line.

    The script sees the runtime's own view of the context
    (PolicyContext.for_runtime): ``command`` is its first captured
    stage, plus ``runtime`` identity in the script payload.

    Args:
        script (PolicyScript): a callable taking the PolicyContext, or
            a config-borne ScriptSource.
        ctx (PolicyContext): the parse context for the line.
        runtime (Runtime): the runtime being asked (ctx.runtime).
        entries (list[Runtime]): the workspace's ordered world; a
            ScriptSource selects its evaluator from it by language.

    Raises:
        PolicyError: the script answered with a policy verdict shape
            (a dict or a PolicyResult arm) instead of a boolean; a
            deny-dict is truthy, so coercing it would mean "willing",
            the opposite of intent.
    """
    view = ctx.for_runtime(runtime)
    verdict: Any
    if isinstance(script, ScriptSource):
        verdict = await _eval_source(script.source, view.to_dict(runtime),
                                     evaluator_of(entries, script.language))
    else:
        verdict = script(view)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if isinstance(verdict, (Mapping, PolicyResult)):
        raise PolicyError(
            f"entry scripts answer a boolean (deny and placement belong "
            f"to the global policy), got {verdict!r} from {runtime.name!r}")
    return bool(verdict)


def parse_verdict(verdict: Any) -> str | None:
    """Normalize a policy verdict to a runtime name or None to pass.

    Accepts the typed arms (RouteResult/DenyResult), a bare name, None,
    and the wire dict the arms serialize to: {"runtime": name} places
    the line, {"deny": reason} refuses it, keys mutually exclusive.
    Unknown keys fail loud so a typo never silently passes.

    Args:
        verdict (Any): whatever the policy returned.

    Raises:
        PolicyDeny: the verdict is DenyResult or {"deny": reason}.
        PolicyError: the verdict is not a PolicyResult arm, a name,
            None, or a verdict dict (mirrors the TS parseVerdict).
    """
    if verdict is None or isinstance(verdict, str):
        return verdict
    if isinstance(verdict, RouteResult):
        return verdict.runtime
    if isinstance(verdict, DenyResult):
        raise PolicyDeny(verdict.reason)
    if isinstance(verdict, Mapping):
        unknown = sorted(set(verdict) - {"runtime", "deny"})
        if unknown:
            raise PolicyError(f"unknown policy verdict keys: {unknown}")
        if "deny" in verdict and "runtime" in verdict:
            raise PolicyError("policy verdict cannot both place and deny")
        if "deny" in verdict:
            raise PolicyDeny(str(verdict["deny"]))
        name = verdict.get("runtime")
        if isinstance(name, str):
            return name
        raise PolicyError("policy verdict dict needs a 'runtime' name "
                          "or a 'deny' reason")
    raise PolicyError(f"policy must return a runtime name, a verdict "
                      f"dict, or None, got {verdict!r}")


async def evaluate_policy(policy: PolicyFn, ctx: PolicyContext,
                          entries: list[Runtime]) -> str | None:
    """Run the global policy, returning a runtime name or None to pass.

    Args:
        policy (PolicyFn): a callable taking the PolicyContext, or a
            config-borne ScriptSource (last expression = the verdict).
        ctx (PolicyContext): the parse context for the line.
        entries (list[Runtime]): the workspace's ordered world; a
            ScriptSource selects its evaluator from it by language.

    Raises:
        PolicyDeny: the policy refused the line.
        ValueError: the policy returned something other than a
            PolicyVerdict.
    """
    verdict: Any
    if isinstance(policy, ScriptSource):
        verdict = await _eval_source(policy.source, ctx.to_dict(),
                                     evaluator_of(entries, policy.language))
    else:
        verdict = policy(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    return parse_verdict(verdict)


async def decide_line(entries: list[Runtime], policy: PolicyFn | None,
                      ctx: PolicyContext,
                      static_bindings: dict[str, Runtime]) -> PolicyDecision:
    """Resolve the policy ladder for one line: policy, then scripts.

    A policy verdict overlays the named runtime's captures on the
    static bindings (an affirmative choice, never a refusal). With no
    verdict, per-runtime scripts filter the entry list: an entry with
    no script is always willing, and the willing entries re-bind in
    list order. The vfs runtime is filtered exactly like the others;
    a command left without a willing runtime is an admission failure
    at dispatch. Config-borne scripts run on the world's evaluator
    (evaluator_of), never on a hardcoded interpreter.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        policy (PolicyFn | None): the global policy, if configured.
        ctx (PolicyContext): the parse context for the line.
        static_bindings (dict[str, Runtime]): the workspace's static
            command bindings.
    """
    if policy is not None:
        name = await evaluate_policy(policy, ctx, entries)
        if name is not None:
            overlay = runtime_bindings_for(entries, name)
            return PolicyDecision(bindings={
                **static_bindings,
                **overlay
            },
                                  fallback=catch_all(entries))
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
