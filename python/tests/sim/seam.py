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
import inspect
from collections import Counter
from collections.abc import AsyncIterator, Callable, Coroutine, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from types import SimpleNamespace
from typing import Any, Protocol, TypeVar
from unittest.mock import patch

from tests.e2e.s3_mock import CONDITION_KEYS, S3_SESSION, MultiBucketS3Client
from tests.sim.loop import SimLoop
from tests.sim.rand import exponential
from tests.sim.trace import (
    STEP,
    Change,
    Requested,
    Served,
    StepRef,
    Trace,
    state_of,
)

T = TypeVar("T")

S3_OPS = frozenset(
    name
    for name, member in vars(MultiBucketS3Client).items()
    if inspect.iscoroutinefunction(member) and not name.startswith("_")
)


class Leg(Enum):
    """A request's trip to the store, or its answer's trip back."""

    OUT = "out"
    BACK = "back"


class Latency(Protocol):
    """How long one leg of one request takes, in virtual seconds."""

    def __call__(
        self, step: StepRef | None, op: str, key: str, nth: int, leg: Leg
    ) -> float:
        """The leg's delay.

        Args:
            step (StepRef | None): the line that sent the request.
            op (str): the client method.
            key (str): the object key.
            nth (int): how many requests with the same step, op and key
                came before it.
            leg (Leg): out to the store or back to the caller.
        """
        ...


def immediate(
    step: StepRef | None, op: str, key: str, nth: int, leg: Leg
) -> float:
    """No latency: order comes from the script's awaits and holds.

    Args:
        step (StepRef | None): the line that sent the request.
        op (str): the client method.
        key (str): the object key.
        nth (int): how many requests with the same step, op and key
            came before it.
        leg (Leg): out to the store or back to the caller.
    """
    del step, op, key, nth, leg
    return 0.0


@dataclass(frozen=True, slots=True)
class Exponential:
    """Keyed exponential latency: a leg's draw depends on who sent it,
    from which line, for what, and how many times, and nothing else.

    Args:
        seed (int): the run's seed.
        mean (float): the mean leg, in virtual seconds.
    """

    seed: int
    mean: float = 0.005

    def __call__(
        self, step: StepRef | None, op: str, key: str, nth: int, leg: Leg
    ) -> float:
        who = (step.actor, step.step) if step is not None else ("-", -1)
        return exponential(
            self.seed, self.mean, "latency", *who, op, key, nth, leg.value
        )


@dataclass(frozen=True, slots=True)
class Match:
    """Which requests a hold applies to.

    Args:
        op (str | None): the client method, None for any.
        key (str | None): the object key, None for any.
        actor (str | None): the sending actor, None for any.
        nth (int | None): which fitting request, counted from 0; None
            for the first.
    """

    op: str | None = None
    key: str | None = None
    actor: str | None = None
    nth: int | None = None

    def fits(self, step: StepRef | None, op: str, key: str) -> bool:
        """Whether a request fits, ignoring ``nth``.

        Args:
            step (StepRef | None): the line that sent it.
            op (str): the client method.
            key (str): the object key.
        """
        actor = step.actor if step is not None else None
        return (
            (self.op is None or self.op == op)
            and (self.key is None or self.key == key)
            and (self.actor is None or self.actor == actor)
        )


class Hold:
    """A request held before it reaches the store.

    Released by ``release()``, or, with ``until``, once a request
    matching ``until`` arrives or nothing else can happen at this
    instant, so a hold a fix makes pointless never hangs. A request
    cancelled while held releases it.

    Args:
        match (Match): which request to hold.
        until (Match | None): the request that releases it.
    """

    def __init__(self, match: Match, until: Match | None) -> None:
        self.match = match
        self.until = until
        self.hits = 0
        self.released = False
        self._gate: asyncio.Future[None] | None = None
        self._what = ""

    @property
    def reached(self) -> bool:
        """Whether the matching request is waiting at the hold."""
        return self._gate is not None and not self.released

    def release(self) -> None:
        """Let the held request go on; later ones pass untouched."""
        self.released = True
        if self._gate is not None and not self._gate.done():
            self._gate.set_result(None)

    def takes(self, step: StepRef | None, op: str, key: str) -> bool:
        """Count a fitting request; whether it is the one to hold.

        Args:
            step (StepRef | None): the line that sent it.
            op (str): the client method.
            key (str): the object key.
        """
        if self.released or self._gate is not None:
            return False
        if not self.match.fits(step, op, key):
            return False
        self.hits += 1
        return self.match.nth is None or self.match.nth == self.hits - 1

    async def wait(self, what: str) -> None:
        """Park the request here until released.

        Args:
            what (str): the request, for a deadlock report.
        """
        self._what = what
        self._gate = asyncio.get_running_loop().create_future()
        try:
            await self._gate
        finally:
            self.released = True

    def describe(self) -> str:
        """The held request, for a deadlock report."""
        return f"{self._what} held by {self.match}"


def _key_of(op: str, kwargs: dict[str, Any]) -> str:
    if op == "delete_objects":
        listed = kwargs.get("Delete", {}).get("Objects", [])
        return str(listed[0]["Key"]) if listed else ""
    return str(kwargs.get("Key", kwargs.get("Prefix", "")))


def _at_once(call: Coroutine[Any, Any, T]) -> T:
    """Run ``call`` to its end without yielding to the loop.

    A request then takes effect at one instant, so the changes it is
    traced with are its own. A fake that suspends inside a request,
    such as through an async ``before`` hook, is refused.

    Args:
        call (Coroutine[Any, Any, T]): the fake's method, not started.

    Raises:
        RuntimeError: the fake suspended.
    """
    try:
        call.send(None)
    except StopIteration as done:
        return done.value
    call.close()
    raise RuntimeError("the S3 fake suspended inside a request")


def _code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str(response.get("Error", {}).get("Code", type(exc).__name__))
    return type(exc).__name__


class Network:
    """The one place a request is delayed, held and traced.

    Each request: trace it, sleep the out leg, wait at a hold, apply it
    to the store at once, trace what changed, sleep the return leg.

    Args:
        trace (Trace): where events go.
        latency (Latency): each leg's delay.
        store (MultiBucketS3Client): the shared in-memory store.
    """

    def __init__(
        self, trace: Trace, latency: Latency, store: MultiBucketS3Client
    ) -> None:
        self._trace = trace
        self._latency = latency
        self._store = store
        self._holds: list[Hold] = []
        self._seen: Counter[tuple[StepRef | None, str, str]] = Counter()
        self._seq = 0
        self._watching = False

    def hold(self, match: Match, until: Match | None = None) -> Hold:
        """Hold the request ``match`` names before it reaches the store.

        Args:
            match (Match): which request.
            until (Match | None): the request that releases it, None to
                release it only by hand.

        Raises:
            ValueError: a match names an op the store does not have, or
                ``until`` is asked for under latency, where every leg is
                a timer and "nothing else can happen" comes too early.
            TypeError: the running loop is not a ``SimLoop``.
        """
        for named in (match, until):
            if named is not None and named.op not in (None, *S3_OPS):
                raise ValueError(f"no such S3 op: {named.op!r}")
        if until is not None and self._latency is not immediate:
            raise ValueError("a hold with until needs immediate latency")
        loop = asyncio.get_running_loop()
        if not isinstance(loop, SimLoop):
            raise TypeError("a hold needs the simulator's loop")
        if not self._watching:
            loop.watch_idle(self._release_waiting, self.held)
            self._watching = True
        hold = Hold(match, until)
        self._holds.append(hold)
        return hold

    def held(self) -> tuple[str, ...]:
        """Every request waiting at a hold."""
        return tuple(h.describe() for h in self._holds if h.reached)

    def _release_waiting(self) -> bool:
        waiting = [h for h in self._holds if h.reached and h.until is not None]
        for hold in waiting:
            hold.release()
        return bool(waiting)

    def _snapshot(self) -> dict[tuple[str, str], bytes]:
        return {
            (bucket, key): data
            for bucket, objects in self._store.buckets.items()
            for key, data in objects.items()
        }

    def _changes(
        self,
        before: dict[tuple[str, str], bytes],
        commits: dict[tuple[str, str], int],
    ) -> tuple[Change, ...]:
        after = self._snapshot()
        return tuple(
            Change(
                key,
                state_of(before.get((bucket, key))),
                state_of(after.get((bucket, key))),
                count,
            )
            for (bucket, key), count in sorted(self._store.commits.items())
            if commits.get((bucket, key)) != count
        )

    async def request(
        self,
        op: str,
        kwargs: dict[str, Any],
        perform: Callable[[], Coroutine[Any, Any, T]],
    ) -> T:
        """Carry one request to the store and its answer back.

        Args:
            op (str): the client method.
            kwargs (dict[str, Any]): its arguments.
            perform (Callable[[], Coroutine[Any, Any, T]]): the fake's
                method, run to its end in one step so it takes effect
                atomically.
        """
        step = STEP.get()
        key = _key_of(op, kwargs)
        sent = tuple(
            (k, str(kwargs[k])) for k in CONDITION_KEYS if k in kwargs
        )
        nth = self._seen[step, op, key]
        self._seen[step, op, key] += 1
        self._seq += 1
        seq = self._seq
        loop = asyncio.get_running_loop()
        self._trace.append(Requested(seq, loop.time(), step, op, key, sent))
        await asyncio.sleep(self._latency(step, op, key, nth, Leg.OUT))
        for hold in self._holds:
            if hold.reached and hold.until is not None:
                if hold.until.fits(step, op, key):
                    hold.release()
        for hold in self._holds:
            if hold.takes(step, op, key):
                await hold.wait(f"{step} {op} {key}")
        before = self._snapshot()
        commits = dict(self._store.commits)
        try:
            answer = _at_once(perform())
        except Exception as exc:
            self._trace.append(
                Served(seq, loop.time(), step, op, key, sent, (), _code(exc))
            )
            await asyncio.sleep(self._latency(step, op, key, nth, Leg.BACK))
            raise
        changes = self._changes(before, commits)
        self._trace.append(
            Served(seq, loop.time(), step, op, key, sent, changes, None)
        )
        await asyncio.sleep(self._latency(step, op, key, nth, Leg.BACK))
        return answer


class _Paginator:
    def __init__(self, network: Network, inner: Any) -> None:
        self._network = network
        self._inner = inner

    async def paginate(self, **kwargs: Any) -> AsyncIterator[dict]:
        pages: list[dict] = []

        async def collect() -> None:
            async for page in self._inner.paginate(**kwargs):
                pages.append(page)

        await self._network.request("list_objects_v2", kwargs, collect)
        for page in pages:
            yield page


class Connection:
    """What a mount's S3 client is in a run: every awaited method of the
    shared fake becomes one ``Network.request``, by ``__getattr__``, so
    no method list is kept in sync with the fake.

    Args:
        network (Network): the gate.
        fake (MultiBucketS3Client): the shared store.
        endpoint (str): the endpoint the client reports.
    """

    def __init__(
        self, network: Network, fake: MultiBucketS3Client, endpoint: str
    ) -> None:
        self._network = network
        self._fake = fake
        self.meta = SimpleNamespace(endpoint_url=endpoint)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._fake, name)
        if name == "get_paginator":
            return lambda op: _Paginator(self._network, attr(op))
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await self._network.request(
                name, kwargs, lambda: attr(*args, **kwargs)
            )

        return call

    async def __aenter__(self) -> "Connection":
        return self

    async def __aexit__(self, *args: Any) -> None:
        del args


class _Session:
    def __init__(self, network: Network, fake: MultiBucketS3Client) -> None:
        self._network = network
        self._fake = fake

    def client(self, **kwargs: Any) -> Connection:
        endpoint = kwargs.get("endpoint_url") or "https://s3.amazonaws.com"
        return Connection(self._network, self._fake, endpoint)


@contextmanager
def route_s3(network: Network, fake: MultiBucketS3Client) -> Iterator[None]:
    """Open every S3 client of the run through ``network``.

    Args:
        network (Network): the gate.
        fake (MultiBucketS3Client): the shared store.
    """
    session = _Session(network, fake)
    with patch(S3_SESSION, side_effect=lambda config: session):
        yield
