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
from collections.abc import Mapping
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.table import NAMED, build_runtime
from mirage.runtime.types import EvalValue, ScriptSource

CTX_GLOBAL = "ctx"


async def eval_with_ctx(
    source: str,
    ctx: dict[str, EvalValue],
    evaluator: EvaluatorMixin,
    timeout: float,
) -> EvalValue:
    """Evaluate a config-borne script and return its last expression.

    The one place the config-script calling convention is written down:
    the payload arrives as a single global named ``ctx``, and the
    script's last expression is its answer. Both evaluated config
    scripts speak it (``route_policy`` and a runtime's entry script),
    and spelling it out per caller is a convention two callers can drift
    apart on. A profile's policy programs are run, not evaluated
    (``script_engine``).

    Deliberately raises rather than words its failures. Each caller
    refuses in its own voice and its own error type (the runtime
    router's RouteError is a ValueError, the permissions layer's
    PolicyError is not), so a shared wording here would put one
    layer's words on the other layer's failure.

    Args:
        source (str): the script program.
        ctx (dict[str, EvalValue]): what the script sees as ``ctx``.
        evaluator (EvaluatorMixin): the engine to run it on.
        timeout (float): seconds to allow before giving up.

    Raises:
        asyncio.TimeoutError: the script outran ``timeout``.
        EvalError: the script did not parse, or raised.
    """
    release = evaluator.admit() if isinstance(evaluator, Runtime) else None
    try:
        result = await asyncio.wait_for(
            evaluator.eval(source, inputs={CTX_GLOBAL: ctx}), timeout=timeout
        )
    finally:
        if release is not None:
            release()
    return result.value


def script_engine(
    script: ScriptSource,
    runtime: str,
    config: Mapping[str, Any] | None = None,
) -> LanguageRuntime:
    """Build the runtime a config program runs on: the one the config
    named, with the settings it gave, and the config always names one.

    There is no default runtime to fall back to: a program without a
    ``runtime`` is refused where the config is validated, because a
    default the operator never wrote is a runtime they never chose. The
    runtime is built fresh and never picked out of a workspace's runtime
    world: the world is the ordered set that serves *agent* code, it is
    mutable after construction, and an entry drops out of it silently
    when an optional dependency is missing. The mismatch checks run
    before the build: a runtime that cannot be installed here would
    otherwise report its missing dependency for a config that names the
    wrong one, which sends the operator after the wrong fix.

    Args:
        script (ScriptSource): the program, carrying its language.
        runtime (str): the runtime the config named.
        config (Mapping[str, Any] | None): its settings, the ``config``
            block a ``runtimes`` entry carries.

    Raises:
        ValueError: the named runtime is unknown, runs no programs,
            speaks another language, or its dependency is missing. The
            message is a clause about "script", for the caller to
            prefix with whose script it is.
    """
    named = NAMED.get(runtime)
    if named is not None:
        if not issubclass(named, LanguageRuntime):
            raise ValueError(
                f"script names runtime {runtime!r}, which runs no programs"
            )
        if named.language != script.language:
            raise ValueError(
                f"script is {script.language}, but names runtime {runtime!r}, "
                f"which speaks {named.language}"
            )
    try:
        built = build_runtime(runtime, config=dict(config or {}))
    except (ValueError, TypeError, ImportError, OSError) as exc:
        # A runtime reports a missing dependency as its own error
        # (ImportError for an absent extra, FileNotFoundError for an
        # absent wasm build), and each carries its own install hint; an
        # unknown setting is a TypeError from its config.
        raise ValueError(f"script names runtime {runtime!r}: {exc}") from exc
    if not isinstance(built, LanguageRuntime):
        raise ValueError(
            f"script names runtime {runtime!r}, which runs no programs"
        )
    return built
