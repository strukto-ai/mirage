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

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.runtime.routing.decide import (
        decide_line,
        evaluate_policy,
        evaluate_script,
        evaluator_of,
        parse_verdict,
        runtime_for_language,
    )
    from mirage.runtime.routing.errors import RouteDeny, RouteError
    from mirage.runtime.routing.facts import command_nodes, parsed_commands
    from mirage.runtime.routing.types import (
        DenyResult,
        ParsedCommand,
        RouteContext,
        RouteDecision,
        RouteOutcome,
        RoutePolicy,
        RouteResult,
        RouteScript,
        RouteVerdict,
    )
    from mirage.runtime.types import ScriptSource

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.runtime.routing.decide": (
        "decide_line",
        "evaluate_policy",
        "evaluate_script",
        "evaluator_of",
        "parse_verdict",
        "runtime_for_language",
    ),
    "mirage.runtime.routing.errors": ("RouteDeny", "RouteError"),
    "mirage.runtime.routing.facts": ("command_nodes", "parsed_commands"),
    "mirage.runtime.routing.types": (
        "DenyResult",
        "ParsedCommand",
        "RouteContext",
        "RouteDecision",
        "RouteOutcome",
        "RoutePolicy",
        "RouteResult",
        "RouteScript",
        "RouteVerdict",
    ),
    "mirage.runtime.types": ("ScriptSource",),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "ParsedCommand",
    "ScriptSource",
    "RouteDecision",
    "RouteContext",
    "RoutePolicy",
    "RouteScript",
    "RouteError",
    "RouteDeny",
    "RouteVerdict",
    "RouteOutcome",
    "RouteResult",
    "DenyResult",
    "parse_verdict",
    "command_nodes",
    "parsed_commands",
    "decide_line",
    "evaluate_policy",
    "evaluate_script",
    "evaluator_of",
    "runtime_for_language",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
