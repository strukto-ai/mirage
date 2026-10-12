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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Generic, TypeVar

from mirage.policy.types import RouteContext
from mirage.runtime.types import RuntimeIdentity, ScriptSource

# A per-runtime willingness script, answering "do I want this line?".
# In code: a callable (sync or async) on the RouteContext returning a
# truthy verdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# RouteScript.
#
#     def wants(ctx: RouteContext) -> bool:
#         return "/secret" not in ctx.line
#
#     WorkspaceRuntime(script=wants)
#
#     # workspace yaml: guard.py next to the config file
#     runtimes:
#       - name: vfs
#         script: guard.py
RouteScript = Callable[[RouteContext], bool | Awaitable[bool]] | ScriptSource

# What the route policy answers: a runtime name places the line, None
# leaves each command to its first capturer. Refusing a line is a
# policy's (a pre_execute Deny), not the router's. Mirrors the TS
# RouteVerdict.
RouteVerdict = str | None

# The route policy, answering "who takes this line?". In code: a
# callable (sync or async) on the RouteContext returning a
# RouteVerdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# RoutePolicy.
#
#     def policy(ctx: RouteContext) -> str | None:
#         names = [c.command for c in ctx.commands]
#         return "wasi" if "python3" in names else None
#
#     Workspace(..., route_policy=policy)
#
#     # workspace yaml: policy.py next to the config file
#     route_policy: policy.py
RoutePolicy = (
    Callable[[RouteContext], RouteVerdict | Awaitable[RouteVerdict]]
    | ScriptSource
)


_R = TypeVar("_R", bound=RuntimeIdentity)


@dataclass(frozen=True, slots=True)
class RouteDecision(Generic[_R]):
    """The one-line placement decision the dispatcher consults.

    Both fields hold runtimes: the decision IS "which runtime runs
    which command". The workspace runtime is a legal value in either; a
    command placed on it is served by the workspace executor itself.

    Args:
        bindings (dict[str, _R | None]): every command some entry
            captures, resolved for this line: the runtime it runs on,
            or None when its capturers all refused (admission failure,
            exit 126, never a silent fallback to the workspace).
        fallback (_R | None): where commands no entry captures
            run: the catch-all workspace runtime, or None when the workspace
            runtime refused the line or declares captures; unbound
            commands then exit 126.
    """

    bindings: dict[str, _R | None] = field(default_factory=dict)
    fallback: _R | None = None
