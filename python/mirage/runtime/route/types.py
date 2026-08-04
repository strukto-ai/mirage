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

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from mirage.policy.types import Deny, ExecuteContext, Route
from mirage.runtime.base import Runtime
from mirage.runtime.types import ScriptSource

# A per-runtime willingness script, answering "do I want this line?".
# In code: a callable (sync or async) on the ExecuteContext returning a
# truthy verdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# PolicyScript.
#
#     def wants(ctx: ExecuteContext) -> bool:
#         return ctx.builtin and "/secret" not in ctx.line
#
#     VfsRuntime(script=wants)
#
#     # workspace yaml: guard.py next to the config file
#     runtimes:
#       - name: vfs
#         script: guard.py
PolicyScript = Callable[[ExecuteContext],
                        bool | Awaitable[bool]] | ScriptSource

# What the routing policy may answer: an Action arm (Route places the
# line, Deny refuses it, exit 126 with ``<command>: policy denied:
# <reason>`` on stderr), a bare runtime name, None to pass, or the
# verdict dict (the wire spelling of the arms, the only form a config
# script can return). Dict keys are mutually exclusive: {"runtime":
# name} places the line, {"deny": reason} refuses it. New powers grow
# as arm fields and dict keys, never as new return types. Mirrors the
# TS PolicyVerdict.
PolicyVerdict = Route | Deny | str | Mapping[str, Any] | None

# The routing policy, answering "who takes this line?". In code: a
# callable (sync or async) on the ExecuteContext returning a
# PolicyVerdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# PolicyFn.
#
#     def policy(ctx: ExecuteContext) -> str | None:
#         return "wasi" if ctx.command == "python3" else None
#
#     Workspace(..., policy=policy)
#
#     # workspace yaml: policy.py next to the config file
#     policy: policy.py
PolicyFn = Callable[[ExecuteContext],
                    PolicyVerdict | Awaitable[PolicyVerdict]] | ScriptSource


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    """The one-line placement decision the dispatcher consults.

    Both fields hold runtimes: the decision IS "which runtime runs
    which command". The vfs runtime is a legal value in either; a
    command placed on it is served by the workspace executor itself.

    Args:
        bindings (dict[str, Runtime | None]): every command some entry
            captures, resolved for this line: the runtime it runs on,
            or None when its capturers all refused (admission failure,
            exit 126, never a silent fallback to the workspace).
        fallback (Runtime | None): where commands no entry captures
            run: the catch-all vfs runtime, or None when the vfs
            runtime refused the line or declares captures; unbound
            commands then exit 126.
    """

    bindings: dict[str, Runtime | None] = field(default_factory=dict)
    fallback: Runtime | None = None
