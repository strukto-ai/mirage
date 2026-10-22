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

import ast
import importlib.util
import time
from pathlib import Path

import pytest

import mirage.cache as cache_pkg
from mirage.utils.clock import Clock, ManualClock, SystemClock

CACHE_DIR = Path(cache_pkg.__file__).parent

SYSTEM_CLOCK_READS = frozenset(
    {
        "time.time",
        "time.time_ns",
        "time.monotonic",
        "time.monotonic_ns",
        "time.perf_counter",
        "time.perf_counter_ns",
        "datetime.datetime.now",
        "datetime.datetime.utcnow",
        "datetime.datetime.today",
        "datetime.date.today",
        "asyncio.get_running_loop().time",
        "asyncio.get_event_loop().time",
        "mirage.utils.dates.now_iso",
        "mirage.utils.dates.utc_date_folder",
    }
)

KEPT_ON_SYSTEM_CLOCK = {
    ("index/listing_memo.py", "time.monotonic"): (
        "the trust window and row-write times are counted per key prefix "
        "across every store sharing it, and those stores may hold "
        "different clocks, so they stay on the process monotonic clock; "
        "listing expiry already reads the store clock"
    ),
}


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
    assert (
        repr(ManualClock(start=5.0)) == "ManualClock(now=5.0, monotonic=0.0)"
    )
    assert repr(SystemClock()) == "SystemClock()"


def _bindings(tree: ast.Module, package: str) -> dict[str, str]:
    """Each name an import binds, mapped to the dotted name it stands for.

    Args:
        tree (ast.Module): a parsed module.
        package (str): the module's package, which relative imports
            resolve against.
    """
    bound: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                bound[alias.asname or top] = (
                    alias.name if alias.asname else top
                )
        elif isinstance(node, ast.ImportFrom):
            module = importlib.util.resolve_name(
                "." * node.level + (node.module or ""), package
            )
            for alias in node.names:
                bound[alias.asname or alias.name] = f"{module}.{alias.name}"
    return bound


def _dotted(node: ast.expr, bound: dict[str, str]) -> str | None:
    """The dotted name ``node`` refers to through the imports, if any.

    A call in the chain keeps its ``()``, so an attribute of what an
    imported function returns resolves too.

    Args:
        node (ast.expr): a name, attribute or call.
        bound (dict[str, str]): the module's import bindings.
    """
    if isinstance(node, ast.Name):
        return bound.get(node.id)
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value, bound)
        return None if base is None else f"{base}.{node.attr}"
    if isinstance(node, ast.Call):
        func = _dotted(node.func, bound)
        return None if func is None else f"{func}()"
    return None


def clock_reads(source: str, package: str) -> set[str]:
    """Every system-clock read ``source`` imports or references.

    Args:
        source (str): a module's Python source.
        package (str): the module's package, which relative imports
            resolve against.
    """
    tree = ast.parse(source)
    bound = _bindings(tree, package)
    named = set(bound.values()) | {
        name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Name, ast.Attribute))
        and (name := _dotted(node, bound))
    }
    return named & SYSTEM_CLOCK_READS


def _cache_clock_reads() -> set[tuple[str, str]]:
    return {
        (path.relative_to(CACHE_DIR).as_posix(), name)
        for path in CACHE_DIR.rglob("*.py")
        for name in clock_reads(
            path.read_text(),
            ".".join(
                (cache_pkg.__name__, *path.relative_to(CACHE_DIR).parent.parts)
            ),
        )
    }


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("import time\ntime.time()", {"time.time"}),
        ("import time as t\nt.monotonic()", {"time.monotonic"}),
        ("from time import time_ns", {"time.time_ns"}),
        ("from time import monotonic as m\nm()", {"time.monotonic"}),
        ("import time\ntime.perf_counter()", {"time.perf_counter"}),
        (
            "from datetime import datetime, timezone\n"
            "datetime.now(timezone.utc)",
            {"datetime.datetime.now"},
        ),
        (
            "from datetime import datetime as dt\ndt.utcnow()",
            {"datetime.datetime.utcnow"},
        ),
        (
            "import datetime\ndatetime.datetime.now()",
            {"datetime.datetime.now"},
        ),
        ("import time\nfield(default_factory=time.time)", {"time.time"}),
        ("from datetime import date\ndate.today()", {"datetime.date.today"}),
        (
            "import asyncio\nasyncio.get_running_loop().time()",
            {"asyncio.get_running_loop().time"},
        ),
        (
            "from asyncio import get_event_loop\nget_event_loop().time()",
            {"asyncio.get_event_loop().time"},
        ),
        (
            "from mirage.utils.dates import now_iso\nnow_iso()",
            {"mirage.utils.dates.now_iso"},
        ),
        (
            "from mirage.utils.dates import utc_date_folder as folder\n"
            "folder()",
            {"mirage.utils.dates.utc_date_folder"},
        ),
        (
            "from ...utils.dates import now_iso\nnow_iso()",
            {"mirage.utils.dates.now_iso"},
        ),
        (
            "from ...utils import dates\ndates.now_iso()",
            {"mirage.utils.dates.now_iso"},
        ),
    ],
)
def test_the_detector_catches_a_planted_clock_read(source, expected):
    assert clock_reads(source, "mirage.cache.file") == expected


@pytest.mark.parametrize(
    "allowed",
    [
        "self.clock.now()",
        "self._clock.monotonic()",
        "from datetime import datetime, timezone\n"
        "datetime.fromtimestamp(self.clock.now(), timezone.utc)",
        "from datetime import datetime, timedelta, timezone",
        "import time\ntime.sleep(1)",
        "import asyncio\nasyncio.get_running_loop().create_task(job)",
        "from mirage.utils.dates import iso_to_epoch\niso_to_epoch(text)",
    ],
)
def test_the_detector_leaves_what_reads_the_injected_clock(allowed):
    assert clock_reads(allowed, "mirage.cache.file") == set()


def test_no_cache_module_reads_the_system_clock_past_the_seam():
    assert _cache_clock_reads() - set(KEPT_ON_SYSTEM_CLOCK) == set()


def test_every_kept_system_clock_read_is_still_made():
    assert set(KEPT_ON_SYSTEM_CLOCK) - _cache_clock_reads() == set()
