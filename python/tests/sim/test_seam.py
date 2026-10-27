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

import pytest

from tests.e2e.s3_mock import MultiBucketS3Client
from tests.sim.loop import run
from tests.sim.seam import (
    Connection,
    Exponential,
    Leg,
    Match,
    Network,
    immediate,
)
from tests.sim.trace import ABSENT, STEP, Requested, Served, StepRef, Trace


def _gate(latency=immediate, files=None):
    trace = Trace()
    store = MultiBucketS3Client({"b": dict(files or {"f": b"f0\n"})})
    network = Network(trace, latency, store)
    return Connection(network, store, "https://s3"), network, trace


async def _as(actor, call):
    token = STEP.set(StepRef(actor, 0))
    try:
        return await call
    finally:
        STEP.reset(token)


def test_both_legs_wait_their_keyed_latency():
    latency = Exponential(seed=3)
    a0 = StepRef("a", 0)

    async def main():
        client, _, trace = _gate(latency)
        loop = asyncio.get_running_loop()
        await _as("b", client.head_object(Bucket="b", Key="f"))
        start = loop.time()
        await _as("a", client.get_object(Bucket="b", Key="f"))
        return start, loop.time(), trace

    start, end, trace = run(main())[0]
    out = latency(a0, "get_object", "f", 0, Leg.OUT)
    back = latency(a0, "get_object", "f", 0, Leg.BACK)
    sent, served = (e for e in trace.events if e.step == a0)
    assert out != back
    assert (sent.at, served.at) == (start, start + out)
    assert end == pytest.approx(start + out + back)


def test_a_draw_depends_on_its_key_alone():
    first = Exponential(seed=3)
    again = Exponential(seed=3)
    key = (StepRef("a", 2), "put_object", "f", 0, Leg.OUT)
    assert first(*key) == again(*key)
    assert first(*key) != Exponential(seed=4)(*key)
    assert first(*key) != first(StepRef("a", 2), "put_object", "f", 1, Leg.OUT)


async def _put_list_and_miss():
    client, _, trace = _gate()
    await _as("a", client.put_object(Bucket="b", Key="g", Body=b"g\n"))
    paginator = client.get_paginator("list_objects_v2")
    pages = [page async for page in paginator.paginate(Bucket="b", Prefix="")]
    with pytest.raises(Exception, match="NoSuchKey"):
        await client.get_object(Bucket="b", Key="missing")
    return pages, trace


def test_every_request_is_traced_listings_included():
    pages, trace = run(_put_list_and_miss())[0]
    assert [k["Key"] for k in pages[0]["Contents"]] == ["f", "g"]
    served = [e for e in trace.events if isinstance(e, Served)]
    assert [(s.op, s.key, s.error) for s in served] == [
        ("put_object", "g", None),
        ("list_objects_v2", "", None),
        ("get_object", "missing", "NoSuchKey"),
    ]
    (change,) = served[0].changes
    assert (change.key, change.before, change.commit) == ("g", ABSENT, 1)
    assert sum(isinstance(e, Requested) for e in trace.events) == 3


async def _hold_then_release(match):
    client, network, trace = _gate()
    loop = asyncio.get_running_loop()
    held = network.hold(match)
    reads = [
        loop.create_task(_as("a", client.get_object(Bucket="b", Key="f")))
        for _ in range(2)
    ]
    await loop.settle()
    parked = (held.reached, [r.done() for r in reads], len(trace.served()))
    held.release()
    await asyncio.gather(*reads)
    return parked, held.reached, len(trace.served()), loop.time()


def test_a_hold_parks_its_request_until_released():
    parked, reached, served, at = run(
        _hold_then_release(Match(op="get_object", actor="a"))
    )[0]
    assert parked == (True, [False, True], 1)
    assert (reached, served, at) == (False, 2, 0)


def test_a_hold_counts_its_matches_from_zero():
    parked, _, _, _ = run(_hold_then_release(Match(actor="a", nth=1)))[0]
    assert parked == (True, [True, False], 1)


async def _cancel_a_held_request():
    client, network, _ = _gate()
    loop = asyncio.get_running_loop()
    held = network.hold(Match(actor="a"))
    read = loop.create_task(_as("a", client.get_object(Bucket="b", Key="f")))
    await loop.settle()
    read.cancel()
    await asyncio.gather(read, return_exceptions=True)
    return held.reached, network.held()


def test_a_cancelled_held_request_leaves_nothing_held():
    assert run(_cancel_a_held_request())[0] == (False, ())


async def _two_puts_a_held_until_b():
    client, network, trace = _gate()
    network.hold(
        Match(op="put_object", actor="a"),
        until=Match(op="put_object", actor="b"),
    )
    put = client.put_object
    await asyncio.gather(
        _as("a", put(Bucket="b", Key="f", Body=b"a\n")),
        _as("b", put(Bucket="b", Key="f", Body=b"b\n")),
    )
    return [s.step.actor for s in trace.served()]


def test_a_hold_with_until_lets_the_until_request_go_first():
    assert run(_two_puts_a_held_until_b())[0] == ["b", "a"]


async def _hold_until_a_request_never_sent():
    client, network, trace = _gate()
    network.hold(Match(actor="a"), until=Match(actor="b"))
    await _as("a", client.get_object(Bucket="b", Key="f"))
    return len(trace.served()), asyncio.get_running_loop().time()


def test_a_hold_with_until_is_released_when_nothing_else_can_run():
    assert run(_hold_until_a_request_never_sent())[0] == (1, 0)


async def _refused_holds():
    _, network, _ = _gate()
    with pytest.raises(ValueError, match="no such S3 op"):
        network.hold(Match(op="get_objet"))
    _, timed, _ = _gate(Exponential(seed=0))
    with pytest.raises(ValueError, match="immediate latency"):
        timed.hold(Match(actor="a"), until=Match(actor="b"))


def test_holds_that_cannot_mean_what_they_say_are_refused():
    run(_refused_holds())


async def _a_fake_that_suspends():
    trace = Trace()
    store = MultiBucketS3Client({"b": {"f": b"f0\n"}})
    store.before("get_object", lambda: asyncio.sleep(0))
    client = Connection(Network(trace, immediate, store), store, "https://s3")
    with pytest.raises(RuntimeError, match="suspended inside a request"):
        await _as("a", client.get_object(Bucket="b", Key="f"))
    return [(s.changes, s.error) for s in trace.served()]


def test_a_fake_that_suspends_inside_a_request_is_refused():
    assert run(_a_fake_that_suspends())[0] == [((), "RuntimeError")]
