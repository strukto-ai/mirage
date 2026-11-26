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
"""How many turns of its workspace's event loop a quiet line took.

``serve.py`` counts them when ``ACCESS_LOOP_TURNS`` names a file and
writes them there as the server stops, for ``run.py`` to check; the
server itself neither keeps nor serves them. A line in another session
of a busy workspace waits a yield of the busy line per turn, so turns
are what a line costs its neighbours. TypeScript runs every workspace on
its one loop, where an await that is already settled takes no turn, so
it has none to count.

Only the workspaces ``run.py`` runs its quiet lines in are counted,
those named from ``QUIET``, and each of their requests runs with the
GIL switch interval at ``UNHURRIED`` seconds. A line that outlives its
yield interval yields, three turns of its loop each time, and that
interval is two switch intervals, read as the line starts
(``mirage.io.yield_budget``): at the deployment's 1 ms a count would
say how fast the runner was that minute, and a line the code made two
turns longer would pass on a quiet runner and fail on a loaded one.
With no yield falling due, a count is what the line's code takes.
Nothing else runs on the server while a quiet line does, so nothing
waits on the GIL behind it.
"""

import asyncio
import re
import sys
from collections.abc import Callable

from starlette.types import ASGIApp, Receive, Scope, Send

LOOP_TURNS_ENV = "ACCESS_LOOP_TURNS"
QUIET = "loop-turns"
UNHURRIED = 30.0
SHELL = re.compile(rf"^/v1/workspaces/({QUIET}[^/]*)/shell$")


class LoopTurns:
    """ASGI middleware counting a quiet workspace's loop turns per shell
    request.

    A workspace's loop is counted from the first shell request that names
    it, by wrapping ``_run_once``, which an asyncio loop calls once a
    turn. A request's count is the turns its workspace's loop took
    between the request arriving and its answer going out, so it is one
    line's whole cost only while nothing else runs on that loop. The
    line runs unhurried, as the module says.

    Args:
        app (ASGIApp): the server app.
        counts (dict[str, list[int]]): where each workspace's request
            counts go, in order.
    """

    def __init__(self, app: ASGIApp, counts: dict[str, list[int]]) -> None:
        self.app = app
        self.counts = counts
        self._turns: dict[asyncio.AbstractEventLoop, list[int]] = {}

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        shell = SHELL.match(scope["path"]) if scope["type"] == "http" else None
        turns = self._counter(scope, shell.group(1)) if shell else None
        if turns is None:
            await self.app(scope, receive, send)
            return
        before = turns[0]
        hurried = sys.getswitchinterval()
        sys.setswitchinterval(UNHURRIED)
        try:
            await self.app(scope, receive, send)
        finally:
            sys.setswitchinterval(hurried)
        self.counts.setdefault(shell.group(1), []).append(turns[0] - before)

    def _counter(self, scope: Scope, workspace_id: str) -> list[int] | None:
        registry = scope["app"].state.registry
        if workspace_id not in registry:
            return None
        loop = registry.get(workspace_id).runner.loop
        if loop not in self._turns:
            turns = self._turns[loop] = [0]
            loop._run_once = _counted(loop._run_once, turns)
        return self._turns[loop]


def _counted(
    run_once: Callable[[], None], turns: list[int]
) -> Callable[[], None]:
    """``run_once``, counting each call in ``turns[0]``.

    Args:
        run_once (Callable[[], None]): the loop's own turn.
        turns (list[int]): the one-item counter.
    """

    def turn() -> None:
        turns[0] += 1
        run_once()

    return turn
