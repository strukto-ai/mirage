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

from contextvars import ContextVar, Token

from mirage.runtime.route import LineRouting

# The routing decision for the command line currently executing in
# this task. execute() sets it (from a pin, the route, or the entry
# scripts) and resets after; nested evals ($(), eval, source, xargs)
# run in the same task context and inherit it, so nested lines never
# re-route.
_line_routing: ContextVar[LineRouting | None] = ContextVar("line_routing",
                                                           default=None)


def push_line_routing(routing: LineRouting) -> Token[LineRouting | None]:
    """Install the routing decision for the current line's task context.

    Args:
        routing (LineRouting): the resolved placement for this line.
    """
    return _line_routing.set(routing)


def reset_line_routing(token: Token[LineRouting | None]) -> None:
    """Restore the decision active before the matching push.

    Args:
        token (Token[LineRouting | None]): the matching push token.
    """
    _line_routing.reset(token)


def current_line_routing() -> LineRouting | None:
    """The routing decision for the currently executing line, if any."""
    return _line_routing.get()
