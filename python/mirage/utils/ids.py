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
import time
import uuid
from collections.abc import MutableSequence
from typing import Protocol, TypeVar

from mirage.utils.clock import Clock, ManualClock

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

_lock = threading.Lock()
_last_ms = -1
_counter = 0


def _stamp() -> tuple[int, int]:
    """Reserve one id's millisecond and counter value, atomically.

    Two ids minted in the same millisecond are ordered by the counter,
    which is the whole reason the counter exists: the obvious
    alternative, bumping the timestamp instead, buys the same ordering
    by stamping a millisecond that has not happened yet. That error is
    unbounded and permanent, since the borrowed value becomes the next
    call's floor: 5000 ids in a burst put every later id five seconds in
    the future, and it stays there until the clock catches up. These ids
    are database keys, so a timestamp ahead of the clock is wrong data,
    not a rounding artifact.

    A millisecond whose counter is exhausted waits for the next one
    rather than borrowing. That needs more than ~3800 ids inside one
    millisecond, roughly seven times the observed burst rate.

    The clock moving backwards (NTP) is the one case where the stamp
    stays ahead of the wall clock: ordering wins there, and the drift is
    bounded by the size of the jump rather than growing per call.

    Returns:
        tuple[int, int]: the unix-millisecond timestamp and the counter.
    """
    global _last_ms, _counter
    with _lock:
        now_ms = time.time_ns() // 1_000_000
        if now_ms > _last_ms:
            _last_ms = now_ms
            _counter = secrets.randbits(COUNTER_SEED_BITS)
            return _last_ms, _counter
        if _counter < COUNTER_MAX:
            _counter += 1
            return _last_ms, _counter
        while now_ms <= _last_ms:
            now_ms = time.time_ns() // 1_000_000
        _last_ms = now_ms
        _counter = secrets.randbits(COUNTER_SEED_BITS)
        return _last_ms, _counter


def uuid7() -> str:
    """Mint an RFC 9562 UUIDv7 in canonical lowercase hyphenated form.

    The first 48 bits are a unix-millisecond timestamp, so ids sort by
    creation time and stay index-friendly as database primary keys; the
    next 12 bits order ids minted inside one millisecond, and the last
    62 bits are random.

    Returns:
        str: canonical UUID string, e.g.
            ``0198c0de-6f3a-7d21-9c4e-8b1f2a3c4d5e``.
    """
    timestamp_ms, counter = _stamp()
    value = (timestamp_ms & TIMESTAMP_MASK) << 80
    value |= VERSION << 76
    value |= (counter & COUNTER_MAX) << 64
    value |= VARIANT << 62
    value |= secrets.randbits(RANDOM_BITS)
    return str(uuid.UUID(int=value))


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


class SystemIdSource:
    """Platform randomness used when no source is supplied."""

    def uuid7(self) -> str:
        """A fresh UUIDv7 stamped from the system clock."""
        return uuid7()

    def random_u32(self) -> int:
        """A uniform 32-bit integer from the process generator."""
        return random.getrandbits(WORD_BITS)

    def __repr__(self) -> str:
        return "SystemIdSource()"


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
        now_ms = int(self._clock.now() * 1000)
        if now_ms > self._last_ms:
            self._last_ms = now_ms
            self._counter = self.random_u32() >> (
                WORD_BITS - COUNTER_SEED_BITS
            )
        elif self._counter < COUNTER_MAX:
            self._counter += 1
        else:
            self._last_ms += 1
            self._counter = self.random_u32() >> (
                WORD_BITS - COUNTER_SEED_BITS
            )
        high = self.random_u32() >> (2 * WORD_BITS - RANDOM_BITS)
        low = self.random_u32()
        value = (self._last_ms & TIMESTAMP_MASK) << 80
        value |= VERSION << 76
        value |= self._counter << 64
        value |= VARIANT << 62
        value |= (high << WORD_BITS) | low
        return str(uuid.UUID(int=value))

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
