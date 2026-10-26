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

import mirage
from mirage.utils.clock import (
    Clock,
    ManualClock,
    SystemClock,
    is_system_clock,
)

MIRAGE_DIR = Path(mirage.__file__).parent

# Every module that reads time and waits through the workspace Clock. A
# package is scanned whole.
SEAMED = (
    "cache",
    "observe",
    "accessor/airtable.py",
    "accessor/base.py",
    "accessor/box.py",
    "accessor/dropbox.py",
    "accessor/google_api.py",
    "core/api/oauth.py",
    "core/api/rate_limit.py",
    "core/box/client.py",
    "core/dropbox/client.py",
    "core/google/client.py",
    "shell/job_table",
    "workspace/files.py",
    "workspace/mount/mount.py",
    "workspace/mount/registry.py",
)

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
    }
)

SYSTEM_WAITS = frozenset(
    {
        "asyncio.sleep",
        "asyncio.timeout",
        "asyncio.wait_for",
        "time.sleep",
        "mirage.utils.abort.cancellable_sleep",
    }
)

KEPT_ON_SYSTEM_CLOCK = {
    ("cache/index/listing_memo.py", "time.monotonic"): (
        "the trust window and row-write times are counted per key prefix "
        "across every store sharing it, and those stores may hold "
        "different clocks, so they stay on the process monotonic clock; "
        "listing expiry already reads the store clock"
    ),
    ("shell/job_table/table.py", "asyncio.timeout"): (
        "bounds a killed job's stop with a loop timer, which a simulated "
        "loop already keeps on virtual time; on a manual clock a clock "
        "sleep would end the bound before the job stops. It also paces "
        "the checks of another owner's lease, which expires on real time "
        "in the store"
    ),
    ("shell/job_table/table.py", "asyncio.sleep"): (
        "paces the renewal of the owner's lease, which expires on real "
        "time in the store, and the retry of a failed watch; a manual "
        "clock's sleep returns at once and would spin both"
    ),
    ("shell/job_table/ram.py", "time.monotonic"): (
        "an owner's lease is compared by every table sharing the store, "
        "and those tables may hold different clocks, so it stays on the "
        "process monotonic clock, as a Redis lease expires on the server's"
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


@pytest.mark.asyncio
async def test_system_clock_sleep_waits_real_time():
    started = time.monotonic()
    await SystemClock().sleep(0.02)
    assert time.monotonic() - started >= 0.015


@pytest.mark.asyncio
async def test_manual_clock_sleep_advances_without_waiting():
    clock = ManualClock(start=10.0)
    started = time.monotonic()
    await clock.sleep(30)
    assert time.monotonic() - started < 1
    assert clock.now() == 40.0
    assert clock.monotonic() == 30.0


@pytest.mark.asyncio
@pytest.mark.parametrize("seconds", [0, -1, float("nan")])
async def test_manual_clock_sleep_of_nothing_advances_nothing(seconds):
    clock = ManualClock(start=10.0)
    await clock.sleep(seconds)
    assert clock.now() == 10.0
    assert clock.monotonic() == 0.0


def test_only_a_platform_clock_is_a_system_clock():
    assert is_system_clock(SystemClock())
    assert not is_system_clock(ManualClock())


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
    """Every system-clock read or wait ``source`` imports or references.

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
    return named & (SYSTEM_CLOCK_READS | SYSTEM_WAITS)


def _seamed_modules() -> list[Path]:
    return sorted(
        module
        for seamed in SEAMED
        for module in (
            (MIRAGE_DIR / seamed).rglob("*.py")
            if (MIRAGE_DIR / seamed).is_dir()
            else [MIRAGE_DIR / seamed]
        )
    )


def _seamed_clock_reads() -> set[tuple[str, str]]:
    return {
        (path.relative_to(MIRAGE_DIR).as_posix(), name)
        for path in _seamed_modules()
        for name in clock_reads(
            path.read_text(),
            ".".join(
                (mirage.__name__, *path.relative_to(MIRAGE_DIR).parent.parts)
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
            "from mirage.utils.dates import now_iso as stamp\nstamp()",
            {"mirage.utils.dates.now_iso"},
        ),
        ("import asyncio\nawait asyncio.sleep(1)", {"asyncio.sleep"}),
        (
            "from asyncio import sleep as wait\nawait wait(1)",
            {"asyncio.sleep"},
        ),
        ("import time\ntime.sleep(1)", {"time.sleep"}),
        (
            "import asyncio\nawait asyncio.wait_for(job, 5)",
            {"asyncio.wait_for"},
        ),
        (
            "import asyncio\nasync with asyncio.timeout(5):\n    pass",
            {"asyncio.timeout"},
        ),
        (
            "from ...utils.abort import cancellable_sleep\n"
            "await cancellable_sleep(1, cancel)",
            {"mirage.utils.abort.cancellable_sleep"},
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
        "await self.clock.sleep(1)",
        "await tm.clock.sleep(delay)",
        "from mirage.utils.dates import utc_date_folder\n"
        "utc_date_folder(self.clock.now())",
        "import asyncio\nasyncio.get_running_loop().create_task(job)",
        "from mirage.utils.dates import iso_to_epoch\niso_to_epoch(text)",
    ],
)
def test_the_detector_leaves_what_reads_the_injected_clock(allowed):
    assert clock_reads(allowed, "mirage.cache.file") == set()


def test_no_seamed_module_reads_or_waits_on_the_system_clock():
    assert _seamed_clock_reads() - set(KEPT_ON_SYSTEM_CLOCK) == set()


def test_every_kept_system_clock_read_is_still_made():
    assert set(KEPT_ON_SYSTEM_CLOCK) - _seamed_clock_reads() == set()


def test_every_seamed_path_exists():
    assert [s for s in SEAMED if not (MIRAGE_DIR / s).exists()] == []
