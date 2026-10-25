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
import random
import secrets
import threading
import uuid
from collections.abc import Callable, MutableSequence
from typing import Protocol, TypeVar

from mirage.utils.clock import Clock, ManualClock, SystemClock

TIMESTAMP_BITS = 48
TIMESTAMP_MASK = (1 << TIMESTAMP_BITS) - 1
# rand_a carries the intra-millisecond counter (RFC 9562 section 6.2,
# "fixed-length dedicated counter"). Seeded well below its maximum so a
# burst has room to climb without rolling over, which is what the RFC
# asks for, while still starting unpredictably.
COUNTER_MAX = (1 << 12) - 1
COUNTER_SEED_BITS = 8
RANDOM_BITS = 62
# Written into the layout by hand: uuid.UUID's own `version` argument
# refuses anything above 5 until Python 3.14.
VERSION = 7
VARIANT = 0b10

MAX_SEED = (1 << 53) - 1
WORD_BITS = 32
WORD_MASK = (1 << WORD_BITS) - 1
SPLITMIX_GAMMA = 0x9E3779B97F4A7C15
SPLITMIX_MUL1 = 0xBF58476D1CE4E5B9
SPLITMIX_MUL2 = 0x94D049BB133111EB
UINT64_MASK = (1 << 64) - 1

T = TypeVar("T")


def _stamp(
    last_ms: int, counter: int, now_ms: int, fresh: Callable[[], int]
) -> tuple[int, int]:
    """The millisecond and counter of the next id after ``last_ms``.

    Two ids minted in the same millisecond are ordered by the counter,
    which is the whole reason the counter exists: the obvious
    alternative, bumping the timestamp instead, buys the same ordering
    by stamping a millisecond that has not happened yet. That error is
    unbounded and permanent, since the borrowed value becomes the next
    call's floor: 5000 ids in a burst put every later id five seconds in
    the future, and it stays there until the clock catches up. These ids
    are database keys, so a timestamp ahead of the clock is wrong data,
    not a rounding artifact.

    A millisecond whose counter is exhausted borrows the next one. On a
    running clock that takes more than ~3800 ids inside one millisecond,
    roughly seven times the observed burst rate. On a clock that stands
    still or went back (a manual clock, NTP) waiting for it would never
    end, and the stamp runs ahead by one millisecond per exhausted
    counter, so ordering wins and the drift stays bounded by the burst.

    Args:
        last_ms (int): the previous id's millisecond, -1 before the
            first.
        counter (int): the previous id's counter.
        now_ms (int): the clock's reading, in unix milliseconds.
        fresh (Callable[[], int]): draws the counter that starts a new
            millisecond.

    Returns:
        tuple[int, int]: the unix-millisecond timestamp and the counter.
    """
    if now_ms > last_ms:
        return now_ms, fresh()
    if counter < COUNTER_MAX:
        return last_ms, counter + 1
    return last_ms + 1, fresh()


def _layout(timestamp_ms: int, counter: int, random_bits: int) -> str:
    """Lay out a UUIDv7 in canonical lowercase hyphenated form.

    Args:
        timestamp_ms (int): the unix-millisecond timestamp.
        counter (int): the 12-bit counter that orders ids inside one
            millisecond.
        random_bits (int): the 62 random bits.
    """
    value = (timestamp_ms & TIMESTAMP_MASK) << 80
    value |= VERSION << 76
    value |= (counter & COUNTER_MAX) << 64
    value |= VARIANT << 62
    value |= random_bits
    return str(uuid.UUID(int=value))


def _crypto_u32() -> int:
    return secrets.randbits(WORD_BITS)


def uuid7() -> str:
    """Mint an RFC 9562 UUIDv7 in canonical lowercase hyphenated form.

    The first 48 bits are a unix-millisecond timestamp, so ids sort by
    creation time and stay index-friendly as database primary keys; the
    next 12 bits order ids minted inside one millisecond, and the last
    62 bits are random. Stamped by the process's own `SystemIdSource`.

    Returns:
        str: canonical UUID string, e.g.
            ``0198c0de-6f3a-7d21-9c4e-8b1f2a3c4d5e``.
    """
    return _SYSTEM_IDS.uuid7()


def new_workspace_id() -> str:
    """Mint a fresh workspace id (UUIDv7).

    Returns:
        str: time-ordered, collision-resistant workspace id.
    """
    return uuid7()


def new_session_id() -> str:
    """Mint a fresh session id (UUIDv7).

    Returns:
        str: time-ordered, collision-resistant session id.
    """
    return uuid7()


class IdSource(Protocol):
    """Where a workspace's generated ids and random draws come from."""

    def uuid7(self) -> str:
        """A fresh RFC 9562 UUIDv7 in canonical lowercase form."""
        ...

    def random_u32(self) -> int:
        """A uniform integer in ``[0, 2**32)``."""
        ...


class _Floor:
    """The last id's millisecond and counter, which the next id follows."""

    __slots__ = ("counter", "last_ms", "lock")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.last_ms = -1
        self.counter = 0


_SYSTEM_FLOOR = _Floor()


class SystemIdSource:
    """Platform randomness used when no source is supplied.

    A UUIDv7 is stamped from ``clock`` and ordered inside one
    millisecond by a counter, as `SeededIdSource` orders its ids. Every
    source on the system clock shares the process's floor, so ids
    minted anywhere in the process sort by when they were made. A
    source on another clock keeps a floor of its own, so a manual clock
    never shares one with the system clock.

    Args:
        clock (Clock | None): the clock ids are stamped from; None is
            the system clock.
    """

    __slots__ = ("_clock", "_floor")

    def __init__(self, clock: Clock | None = None) -> None:
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._floor = (
            _SYSTEM_FLOOR if isinstance(self._clock, SystemClock) else _Floor()
        )

    def uuid7(self) -> str:
        """A fresh UUIDv7 stamped from the source's clock."""
        floor = self._floor
        with floor.lock:
            floor.last_ms, floor.counter = _stamp(
                floor.last_ms,
                floor.counter,
                int(self._clock.now() * 1000),
                self._fresh_counter,
            )
            timestamp_ms, counter = floor.last_ms, floor.counter
        high = _crypto_u32() >> (2 * WORD_BITS - RANDOM_BITS)
        low = _crypto_u32()
        return _layout(timestamp_ms, counter, (high << WORD_BITS) | low)

    def _fresh_counter(self) -> int:
        return _crypto_u32() >> (WORD_BITS - COUNTER_SEED_BITS)

    def random_u32(self) -> int:
        """A uniform 32-bit integer from the process generator."""
        return random.getrandbits(WORD_BITS)

    def __repr__(self) -> str:
        return f"SystemIdSource(clock={self._clock!r})"


_SYSTEM_IDS = SystemIdSource()


def _splitmix64(state: int) -> tuple[int, int]:
    """One SplitMix64 step: the next state and its output.

    Args:
        state (int): the 64-bit state before the step.
    """
    state = (state + SPLITMIX_GAMMA) & UINT64_MASK
    z = state
    z = ((z ^ (z >> 30)) * SPLITMIX_MUL1) & UINT64_MASK
    z = ((z ^ (z >> 27)) * SPLITMIX_MUL2) & UINT64_MASK
    return state, z ^ (z >> 31)


def _rotl(value: int, shift: int) -> int:
    """Rotate a 32-bit word left.

    Args:
        value (int): the word.
        shift (int): how far, from 1 to 31.
    """
    return ((value << shift) | (value >> (WORD_BITS - shift))) & WORD_MASK


class SeededIdSource:
    """Ids and draws replayed exactly from a seed.

    Draws come from xoshiro128** (Blackman and Vigna) seeded through
    SplitMix64, so one seed yields one sequence on every host and in
    both languages. A UUIDv7 is stamped from ``clock``, ordered inside
    one millisecond by a counter as `uuid7` is, and borrows the next
    millisecond rather than waiting when that counter runs out.

    Args:
        seed (int): the sequence to replay, from 0 to ``2**53 - 1``.
        clock (Clock | None): the clock ids are stamped from; None
            means a `ManualClock` at zero, so ids depend on the seed
            alone.
    """

    __slots__ = ("_clock", "_counter", "_last_ms", "_seed", "_state")

    def __init__(self, seed: int, clock: Clock | None = None) -> None:
        if not 0 <= seed <= MAX_SEED:
            raise ValueError(f"seed must be in [0, 2**53 - 1]: {seed!r}")
        self._seed = seed
        self._clock: Clock = clock if clock is not None else ManualClock()
        state, first = _splitmix64(seed)
        _, second = _splitmix64(state)
        self._state = [
            first >> WORD_BITS,
            first & WORD_MASK,
            second >> WORD_BITS,
            second & WORD_MASK,
        ]
        self._last_ms = -1
        self._counter = 0

    def random_u32(self) -> int:
        """The next 32-bit draw of the seeded sequence."""
        s = self._state
        result = (_rotl((s[1] * 5) & WORD_MASK, 7) * 9) & WORD_MASK
        t = (s[1] << 9) & WORD_MASK
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = _rotl(s[3], 11)
        return result

    def uuid7(self) -> str:
        """The next UUIDv7 of the seeded sequence, stamped from the clock."""
        self._last_ms, self._counter = _stamp(
            self._last_ms,
            self._counter,
            int(self._clock.now() * 1000),
            self._fresh_counter,
        )
        high = self.random_u32() >> (2 * WORD_BITS - RANDOM_BITS)
        low = self.random_u32()
        return _layout(self._last_ms, self._counter, (high << WORD_BITS) | low)

    def _fresh_counter(self) -> int:
        return self.random_u32() >> (WORD_BITS - COUNTER_SEED_BITS)

    def __repr__(self) -> str:
        return f"SeededIdSource(seed={self._seed!r})"


def random_below(ids: IdSource, limit: int) -> int:
    """A uniform integer in ``[0, limit)`` drawn from ``ids``.

    Whole 32-bit words are drawn, most significant first, the top
    ``limit.bit_length()`` bits kept, and a value past the limit drawn
    again, which discards at most half the draws. Every host draws the
    same words for the same limit, so a seeded source answers the same
    value in both languages.

    Args:
        ids (IdSource): the source to draw from.
        limit (int): the exclusive bound; must be positive.
    """
    if limit <= 0:
        raise ValueError(f"limit must be positive: {limit!r}")
    bits = limit.bit_length()
    if bits <= WORD_BITS:
        shift = WORD_BITS - bits
        while True:
            value = ids.random_u32() >> shift
            if value < limit:
                return value
    words = -(-bits // WORD_BITS)
    shift = words * WORD_BITS - bits
    while True:
        drawn = 0
        for _ in range(words):
            drawn = (drawn << WORD_BITS) | ids.random_u32()
        value = drawn >> shift
        if value < limit:
            return value


def shuffle(ids: IdSource, items: MutableSequence[T]) -> None:
    """Permute ``items`` in place, uniformly, with draws from ``ids``.

    Args:
        ids (IdSource): the source to draw from.
        items (MutableSequence[T]): what to permute.
    """
    for i in range(len(items) - 1, 0, -1):
        j = random_below(ids, i + 1)
        items[i], items[j] = items[j], items[i]
