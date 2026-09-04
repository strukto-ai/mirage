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

import time

import pytest

from mirage.utils.clock import Clock, ManualClock, SystemClock


def test_system_clock_satisfies_the_protocol():
    clock: Clock = SystemClock()
    assert isinstance(clock.now(), float)
    assert isinstance(clock.monotonic(), float)


def test_system_clock_now_tracks_the_wall_clock():
    before = time.time()
    reading = SystemClock().now()
    after = time.time()
    assert before <= reading <= after


def test_system_clock_monotonic_never_decreases():
    clock = SystemClock()
    readings = [clock.monotonic() for _ in range(50)]
    assert readings == sorted(readings)


def test_manual_clock_satisfies_the_protocol():
    clock: Clock = ManualClock()
    assert clock.now() == 0.0
    assert clock.monotonic() == 0.0


def test_manual_clock_stands_still_when_read():
    # Reading must have no side effect: a deadline that moved every time
    # the code under test glanced at the clock would make every boundary
    # assertion depend on the number of glances.
    clock = ManualClock(start=100.0)
    assert clock.now() == 100.0
    assert clock.now() == 100.0
    assert clock.monotonic() == 0.0
    assert clock.monotonic() == 0.0


def test_manual_clock_advance_moves_both_readings():
    clock = ManualClock(start=1000.0)
    clock.advance(30)
    assert clock.now() == 1030.0
    assert clock.monotonic() == 30.0


def test_manual_clock_advance_accumulates():
    clock = ManualClock()
    clock.advance(0.5)
    clock.advance(0.25)
    assert clock.monotonic() == 0.75


def test_manual_clock_orders_two_events_by_advancing_between_them():
    # The ordering case the ticking draft existed for, done explicitly.
    clock = ManualClock(start=1000.0)
    first = clock.now()
    clock.advance(1)
    second = clock.now()
    assert second > first


def test_manual_clock_refuses_to_go_backwards():
    clock = ManualClock()
    with pytest.raises(ValueError):
        clock.advance(-1)


def test_manual_clock_repr_names_both_readings():
    assert repr(
        ManualClock(start=5.0)) == "ManualClock(now=5.0, monotonic=0.0)"
    assert repr(SystemClock()) == "SystemClock()"
