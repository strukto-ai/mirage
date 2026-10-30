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
import hashlib
import os
import pathlib
import subprocess
import sys
from collections.abc import Awaitable, Callable

import pytest

from mirage import WritePolicy
from tests.sim.model import Verdict, no_lost_update
from tests.sim.rand import stream
from tests.sim.seam import Exponential
from tests.sim.trace import StepRef, Trace
from tests.sim.world import Actor, Sim, simulate

KEYS = ("f", "g", "new")
SEEDED = {"f": b"f0\n", "g": b"g0\n"}
PADDING = {f"pad{i}": b"x" * 400 for i in range(3)}
PYTHON_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _puts(trace: Trace, step: StepRef) -> list[dict[str, str]]:
    return [
        dict(s.sent)
        for s in trace.served()
        if s.step == step and s.op == "put_object"
    ]


def _etag(content: bytes) -> str:
    return '"' + hashlib.md5(content).hexdigest() + '"'


def _judged(trace: Trace) -> Verdict:
    verdict = no_lost_update(trace)
    assert verdict.unjudged == [], trace.render()
    assert verdict.false_refusals == [], trace.render()
    return verdict


def _lost(trace: Trace) -> list[str]:
    return [str(lost.step) for lost in _judged(trace).lost]


async def _i1(sim: Sim) -> int:
    a = await sim.workspace().actor("a", "sa")
    b = await sim.workspace().actor("b", "sb")
    await a.read("f")
    await b.read("f")
    await a.write("f")
    return (await b.write("f")).exit_code


def test_guards_432_i1_two_workspaces_refuse_the_stale_write():
    exit_code, trace = simulate(_i1, files=SEEDED)
    assert exit_code == 1
    assert _lost(trace) == []


async def _own_and_blind_writes(sim: Sim) -> None:
    a = await sim.workspace().actor("a", "sa")
    await a.read("f")
    await a.write("f")
    await a.write("f")
    await a.write("g")
    await a.write("g")


def test_the_basis_allows_own_overwrites_and_blind_writes():
    _, trace = simulate(_own_and_blind_writes, files={"f": b"f0\n"})
    verdict = _judged(trace)
    assert (verdict.lost, verdict.blind) == ([], 1)


async def _i2(sim: Sim) -> int:
    ws = sim.workspace()
    a, b = await ws.actor("a", "sa"), await ws.actor("b", "sb")
    await a.read("f")
    await b.read("f")
    await a.write("f")
    return (await b.write("f")).exit_code


def test_guards_1922_sessions_keep_their_own_etags():
    """A peer's write cannot advance the stale session's condition."""
    exit_code, trace = simulate(_i2, files=SEEDED)
    ((a_sent,), (b_sent,)) = (
        _puts(trace, StepRef("a", 1)),
        _puts(trace, StepRef("b", 1)),
    )
    assert exit_code == 1
    assert b_sent["IfMatch"] == a_sent["IfMatch"]
    assert _lost(trace) == []


async def _i3(sim: Sim) -> int:
    a = await sim.workspace(cache_limit=1000).actor("a", "sa")
    p = await sim.workspace().actor("p", "sp")
    await a.read("f")
    await p.read("f")
    await p.write("f")
    await a.sh("cat /s3/pad0 /s3/pad1 /s3/pad2 > /dev/null")
    return (await a.write("f")).exit_code


def test_guards_432_i3_a_basis_outlives_its_evicted_bytes():
    """#432 I3: A's cached copy of f is evicted by later reads; the
    version A read is not, so A's write after a peer's is refused."""
    exit_code, trace = simulate(_i3, files={**SEEDED, **PADDING})
    assert exit_code == 1
    assert _puts(trace, StepRef("a", 2)) == [{"IfMatch": _etag(SEEDED["f"])}]
    assert _lost(trace) == []


async def _i4(sim: Sim) -> int:
    a = await sim.workspace().actor("a", "sa")
    p = await sim.workspace().actor("p", "sp")
    await a.exists("new")
    await p.exists("new")
    await p.write("new")
    return (await a.write("new")).exit_code


def test_guards_432_i4_a_create_race_is_refused():
    """#432 I4: A saw no file and a peer created it; A's write asks that
    the file still not exist, so it is refused instead of replacing the
    peer's."""
    exit_code, trace = simulate(_i4)
    assert exit_code == 1
    assert _puts(trace, StepRef("a", 1)) == [{"IfNoneMatch": "*"}]
    assert _lost(trace) == []


def _copy_race(verb: str) -> Callable[[Sim], Awaitable[int]]:
    async def race(sim: Sim) -> int:
        a = await sim.workspace().actor("a", "sa")
        p = await sim.workspace().actor("p", "sp")
        await a.exists("new")
        await p.write("new")
        return (await a.sh(f"{verb} /s3/f /s3/new")).exit_code

    return race


@pytest.mark.parametrize("verb", ["cp", "mv"])
def test_guards_432_a_copy_onto_a_file_seen_missing_is_refused(verb):
    """#432 I4 for copies: A saw no file, a peer created it, and A's copy
    asks that it still not exist, so the peer's file stays."""
    exit_code, trace = simulate(_copy_race(verb), files=SEEDED)
    (copy,) = (s for s in trace.served() if s.op == "copy_object")
    assert exit_code == 1
    assert dict(copy.sent)["IfNoneMatch"] == "*"
    assert copy.changes == ()


async def _i5(sim: Sim) -> tuple[int, int]:
    a = await sim.workspace().actor("a", "sa")
    p = await sim.workspace().actor("p", "sp")
    await a.read("g")
    await p.remove("g")
    refused = (await a.write("g")).exit_code
    await p.exists("g")
    await p.write("g")
    return refused, (await a.write("g")).exit_code


def test_guards_432_i5_a_refusal_keeps_the_basis():
    """#432 I5: A reads g, a peer removes it, A's write is refused, the
    peer creates g again, and A's next write on the same stale read is
    refused again rather than landing plain over it."""
    exits, trace = simulate(_i5, files={"g": b"g0\n"})
    assert exits == (1, 1)
    assert _puts(trace, StepRef("a", 2)) == [{"IfMatch": _etag(b"g0\n")}]
    assert _lost(trace) == []


async def _rmw_agent(
    actor: Actor, seed: int, existing_only: bool = False
) -> None:
    rng = stream(seed, "actor", actor.name)
    for _ in range(rng.randint(1, 6)):
        await asyncio.sleep(rng.expovariate(50))
        key = rng.choice(tuple(SEEDED) if existing_only else KEYS)
        roll = rng.random()
        if existing_only or roll < 0.45:
            if (await actor.read(key)).exit_code == 0:
                await asyncio.sleep(rng.expovariate(100))
                await actor.write(key)
        elif roll < 0.65:
            if (await actor.exists(key)).exit_code == 1:
                await asyncio.sleep(rng.expovariate(100))
                await actor.write(key)
            else:
                await actor.read(key)
        elif roll < 0.8:
            await actor.write(key)
        elif roll < 0.9:
            await actor.remove(key)
        else:
            await actor.sh("ls /s3 > /dev/null")


async def _rmw(sim: Sim, existing_only: bool = False) -> None:
    world = stream(sim.seed, "world")
    workspaces = [sim.workspace() for _ in range(world.randint(1, 2))]
    actors = [
        await world.choice(workspaces).actor(f"s{i}", f"s{i}")
        for i in range(world.randint(2, 4))
    ]
    await asyncio.gather(
        *(_rmw_agent(a, sim.seed, existing_only) for a in actors)
    )


def _rmw_trace(seed: int, existing_only: bool = False) -> Trace:
    _, trace = simulate(
        lambda sim: _rmw(sim, existing_only),
        seed=seed,
        files=SEEDED,
        latency=Exponential(seed),
    )
    return trace


def test_guards_1922_random_read_modify_write_of_existing_files():
    """Stale reads cannot overwrite peer writes across 100 schedules."""
    for seed in range(100):
        trace = _rmw_trace(seed, existing_only=True)
        assert _judged(trace).lost == [], trace.render()


def test_guards_432_random_read_modify_write():
    """#432: concurrent reads, existence checks, writes and removes on
    ``write: conditional`` lose no update and refuse no write whose basis
    held, on any seed, while writes still land."""
    commits = 0
    for seed in range(100):
        trace = _rmw_trace(seed)
        assert _judged(trace).lost == [], (seed, trace.render())
        commits += sum(1 for served in trace.served() if served.changes)
    assert commits >= 400


def _digest(seeds: range) -> str:
    digest = hashlib.sha256()
    for seed in seeds:
        digest.update(_rmw_trace(seed).render().encode())
    return digest.hexdigest()


def test_the_same_seed_replays_the_same_trace_across_hash_seeds():
    """Replay holds across processes, whose set and dict orders differ."""
    script = "from tests.sim.test_lost_update import _digest; print(_digest(range(5)))"
    other = subprocess.run(
        [sys.executable, "-c", script],
        cwd=PYTHON_ROOT,
        env={**os.environ, "PYTHONHASHSEED": "12345"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert other.stdout.strip() == _digest(range(5)) == _digest(range(5))


async def _unconditional_i1(sim: Sim) -> int:
    a = await sim.workspace(WritePolicy.UNCONDITIONAL).actor("a", "sa")
    b = await sim.workspace(WritePolicy.UNCONDITIONAL).actor("b", "sb")
    await a.read("f")
    await b.read("f")
    await a.write("f")
    return (await b.write("f")).exit_code


def test_the_model_flags_the_loss_an_unconditional_mount_allows():
    exit_code, trace = simulate(_unconditional_i1, files=SEEDED)
    assert exit_code == 0
    assert _lost(trace) == ["b.1"]
