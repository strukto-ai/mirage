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

from collections.abc import Mapping
from typing import Any

from mirage.runtime.language import LanguageRuntime
from mirage.runtime.table import NAMED, build_runtime
from mirage.runtime.types import ScriptSource


def script_engine(
    script: ScriptSource,
    runtime: str,
    config: Mapping[str, Any] | None = None,
) -> LanguageRuntime[Any]:
    """Build the runtime a config program runs on: the one the config
    named, with the settings it gave.

    A policy program that names no runtime arrives here as monty, the
    default its config model fills in, so a missing monty extra is
    reported as any missing dependency is, never swapped for another
    runtime. The runtime is built fresh and never picked out of a
    workspace's runtime world: the world is the ordered set that serves
    *agent* code, it is mutable after construction, and an entry drops
    out of it silently when an optional dependency is missing. The
    mismatch checks run
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
