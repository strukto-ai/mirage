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
"""How many turns of its workspace's event loop each shell request took.

``serve.py`` counts them when ``ACCESS_LOOP_TURNS`` names a file and
writes them there as the server stops, for ``run.py`` to check; the
server itself neither keeps nor serves them. A line in another session
of a busy workspace waits a yield of the busy line per turn, so turns
are what a line costs its neighbours. TypeScript runs every workspace on
its one loop, where an await that is already settled takes no turn, so
it has none to count.
"""

import asyncio
import re
from collections.abc import Callable

from starlette.types import ASGIApp, Receive, Scope, Send

LOOP_TURNS_ENV = "ACCESS_LOOP_TURNS"
SHELL = re.compile(r"^/v1/workspaces/([^/]+)/shell$")


class LoopTurns:
    """ASGI middleware counting a workspace loop's turns per shell request.

    A workspace's loop is counted from the first shell request that names
    it, by wrapping ``_run_once``, which an asyncio loop calls once a
    turn. A request's count is the turns its workspace's loop took
    between the request arriving and its answer going out, so it is one
    line's whole cost only while nothing else runs on that loop.

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
        await self.app(scope, receive, send)
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
