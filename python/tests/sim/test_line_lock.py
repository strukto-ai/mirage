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
from typing import Any

from mirage.workspace.session.manager import SessionManager
from tests.sim.seam import Exponential, Match
from tests.sim.world import Sim, simulate

PROBE = "export T={token}; cat /s3/f > /dev/null; echo $T"
CLEAN = [b"aaa\n", b"bbb\n"]
TOKENS = {b"aaa", b"bbb"}


class _NoLock:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: Any) -> None:
        del args


def _no_line_lock(self: SessionManager, session_id: str) -> _NoLock:
    del self, session_id
    return _NoLock()


async def _second_line_while_first_is_held(sim: Sim):
    ws = sim.workspace()
    a, b = await ws.actor("a"), await ws.actor("b")
    held = sim.hold(Match(actor="a", nth=0))
    first = a.start(PROBE.format(token="aaa"))
    await sim.settle()
    second = b.start("export T=bbb; echo $T")
    await sim.settle()
    queued = held.reached and not second.done()
    held.release()
    return queued, (await first).stdout, (await second).stdout


def test_guards_411_a_second_line_on_a_session_waits_for_the_first():
    """#411: B's whole line must not run inside A's, on one session."""
    outcome, _ = simulate(
        _second_line_while_first_is_held, files={"f": b"x\n"}
    )
    assert outcome == (True, b"aaa\n", b"bbb\n")


async def _two_probes(sim: Sim) -> list[bytes]:
    ws = sim.workspace()
    actors = [await ws.actor(name) for name in ("a", "b")]
    results = await asyncio.gather(
        *(actor.sh(PROBE.format(token=actor.name * 3)) for actor in actors)
    )
    return [result.stdout for result in results]


def _cross_talk(seeds: range) -> list[int]:
    crossed = []
    for seed in seeds:
        stdout, _ = simulate(
            _two_probes,
            seed=seed,
            files={"f": b"x\n"},
            latency=Exponential(seed),
        )
        printed = b"".join(stdout).split()
        assert len(printed) == 2 and set(printed) <= TOKENS, (seed, stdout)
        if stdout != CLEAN:
            crossed.append(seed)
    return crossed


def test_guards_411_concurrent_lines_on_one_session_never_cross_talk():
    assert _cross_talk(range(20)) == []


def test_without_the_line_lock_lines_cross_talk_within_20_seeds(monkeypatch):
    """The sensitivity control for #411: the guard above would fail."""
    monkeypatch.setattr(SessionManager, "line_lock_for", _no_line_lock)
    assert _cross_talk(range(20))
