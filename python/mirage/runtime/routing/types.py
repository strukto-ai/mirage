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
from typing import Any

from mirage.policy.profile import ProfilePolicy
from mirage.policy.types import RouteContext

# What a route policy callable answers: a runtime name places the line,
# None leaves each command to its first capturer. Refusing a line is a
# policy's (a pre_execute Deny), not the router's. Mirrors the TS
# RouteVerdict.
RouteVerdict = str | None

# The route policy, answering "who takes this line?". In code: a
# callable (sync or async) on the RouteContext returning a
# RouteVerdict. Or a program, ``{script, runtime}``, run as a profile's
# policy programs run: it reads the context as JSON and prints its
# answer. Mirrors the TS RoutePolicy.
#
#     def policy(ctx: RouteContext) -> str | None:
#         names = [c.command for c in ctx.commands]
#         return "wasi" if "python3" in names else None
#
#     Workspace(..., route_policy=policy)
#
#     # workspace yaml: route.py next to the config file
#     route_policy: {script: route.py, runtime: monty}
RoutePolicy = (
    Callable[[RouteContext], RouteVerdict | Awaitable[RouteVerdict]]
    | ProfilePolicy
    | Mapping[str, Any]
)
