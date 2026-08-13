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
import secrets
import threading
import time
import uuid

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
