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
import time

import pytest

from mirage import MountMode, RAMResource, Workspace


async def _run(ws: Workspace, line: str) -> tuple[str, str, int]:
    io = await ws.execute(line)
    return await io.stdout_str(), await io.stderr_str(), io.exit_code


# Pinned against GNU date 9.x on debian:stable-slim with tzdata: the
# zone is the command's own TZ, a prefix assignment and an exported
# variable alike, `-u` outranks it, and an instant renders on the calendar
# day the zone shows (issue #1070).
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("TZ=UTC date -d '@0' '+%Y-%m-%d %H:%M:%S %z'",
         "1970-01-01 00:00:00 +0000\n"),
        ("TZ=Asia/Hong_Kong date -d '@0' '+%Y-%m-%d %H:%M:%S %z'",
         "1970-01-01 08:00:00 +0800\n"),
        ("export TZ=Asia/Hong_Kong; date -d '@0' '+%F %T %z'",
         "1970-01-01 08:00:00 +0800\n"),
        ("TZ=Asia/Hong_Kong date -u -d '@0' '+%F %T %z %Z'",
         "1970-01-01 00:00:00 +0000 UTC\n"),
        ("TZ=Asia/Hong_Kong date -d '1970-01-01T20:00:00Z' '+%F %T'",
         "1970-01-02 04:00:00\n"),
        ("TZ=Asia/Hong_Kong date -d '1970-01-01T20:00:00Z 1 day' '+%F %T'",
         "1970-01-03 04:00:00\n"),
        ("TZ=Asia/Hong_Kong date -d '1970-01-01 00:00:00' +%s", "-28800\n"),
        ("TZ=Asia/Hong_Kong date -d '@0' -R",
         "Thu, 01 Jan 1970 08:00:00 +0800\n"),
        ("TZ=Asia/Hong_Kong date -d '1970-01-01T20:00:00Z' -I",
         "1970-01-02\n"),
        ("TZ=America/Los_Angeles date -d @1751328000 '+%F %T %z'",
         "2025-06-30 17:00:00 -0700\n"),
        ("TZ=Bogus/Zone date -d @0 '+%F %T %z %Z'",
         "1970-01-01 00:00:00 +0000 Bogus\n"),
        ("TZ=:Asia/Tokyo date -d @0 '+%T %z'", "09:00:00 +0900\n"),
        ("TZ=UTC0 date -d @0 '+%T %z %Z'", "00:00:00 +0000 UTC\n"),
        ("TZ='<+0530>-5:30' date -d @0 '+%T %z %Z %:z'",
         "05:30:00 +0530 +0530 +05:30\n"),
        ("TZ='CET-1CEST,M3.5.0,M10.5.0/3' date -d @1751328000 '+%F %T %z %Z'",
         "2025-07-01 02:00:00 +0200 CEST\n"),
        ("TZ='CET-1CEST,M3.5.0,M10.5.0/3' date -d '2025-10-26 02:30:00' "
         "'+%s %Z'", "1761442200 CET\n"),
        ("TZ='CET-1CEST,M3.5.0,M10.5.0/3' date -d '2025-03-29 12:00:00 1 day' "
         "'+%F %T %Z'", "2025-03-30 12:00:00 CEST\n"),
        ("TZ='CET-1CEST,M3.5.0,M10.5.0/3' date -d '2025-03-29 12:00:00 "
         "24 hours' '+%F %T %Z'", "2025-03-30 13:00:00 CEST\n"),
        ("TZ=UTC date -d @0 '+%a %Z'", "Thu UTC\n"),
        ("TZ= date -d @0 '+%F %T %z'", "1970-01-01 00:00:00 +0000\n"),
        # A day shift landing in the hour CEST skips moves past the gap, and
        # one landing in the hour it repeats keeps the base's side (gnulib
        # hands mktime the base's tm_isdst).
        ("TZ=Europe/Berlin date -d '2025-03-29 02:30:00 1 day' '+%F %T %z %Z'",
         "2025-03-30 03:30:00 +0200 CEST\n"),
        ("TZ=Europe/Berlin date -d '2025-10-25 02:30:00 1 day' '+%F %T %z %Z'",
         "2025-10-26 02:30:00 +0200 CEST\n"),
        ("TZ=Europe/Berlin date -d '2025-10-27 02:30:00 1 day ago' "
         "'+%F %T %z %Z'", "2025-10-26 02:30:00 +0100 CET\n"),
        # glibc keeps the names and offsets of a POSIX string whose rule it
        # refuses, and clamps an offset's minutes at 59.
        ("TZ='CET-1CEST,bogus' date -d @1720000000 '+%z %Z'", "+0200 CEST\n"),
        ("TZ=UTC5:99 date -d @0 '+%T %z'", "18:01:00 -0559\n"),
        ("(export TZ=Asia/Hong_Kong; date -d @0 +%H); date -u -d @0 +%H",
         "08\n00\n"),
    ])
async def test_date_honors_the_command_environment_tz(line, expected):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == (expected, "", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_date_refuses_a_wall_clock_the_zone_skips():
    # glibc's mktime finds no instant for 02:30 on the night CEST starts.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert await _run(
            ws, "TZ=Europe/Berlin date -d '2025-03-30 02:30:00' +%s") == (
                "", "date: invalid date '2025-03-30 02:30:00'\n", 1)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_tz_never_leaks_between_workspaces():
    # Two workspaces render one instant at once, each under its own TZ:
    # the zone is read from the command environment, never set on the
    # process, so neither can move the other's clock.
    hong_kong = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    utc = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await hong_kong.execute("export TZ=Asia/Hong_Kong")
        await utc.execute("export TZ=UTC")
        line = "date -d @0 '+%H %z'"
        results = await asyncio.gather(
            *[_run(ws, line) for ws in (hong_kong, utc, hong_kong, utc)])
        assert [r[0] for r in results
                ] == ["08 +0800\n", "00 +0000\n", "08 +0800\n", "00 +0000\n"]
        plain = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
        try:
            out, _, _ = await _run(plain, "date -u -d @0 '+%H %z'")
            assert out == "00 +0000\n"
        finally:
            await plain.close()
    finally:
        await hong_kong.close()
        await utc.close()


# `%Z` is tzdata's abbreviation in both hosts (GNU date on
# debian:stable-slim): lettered where tzdata has letters, the offset
# spelled out where it does not, and a zone's own history applies.
@pytest.mark.asyncio
@pytest.mark.parametrize("line,expected", [
    ("TZ=Asia/Hong_Kong date -d @0 +%Z", "HKT\n"),
    ("TZ=Europe/London date -d @1751328000 +%Z; "
     "TZ=Europe/London date -d @1735689600 +%Z", "BST\nGMT\n"),
    ("TZ=Australia/Sydney date -d @1751328000 +%Z; "
     "TZ=Australia/Sydney date -d @1735689600 +%Z", "AEST\nAEDT\n"),
    ("TZ=Asia/Kolkata date -d @0 '+%Z %z'", "IST +0530\n"),
    ("TZ=Asia/Singapore date -d @0 +%Z; "
     "TZ=Asia/Singapore date -d @1751328000 +%Z", "+0730\n+08\n"),
    ("TZ=America/Sao_Paulo date -d @0 +%Z", "-03\n"),
    ("TZ=Etc/GMT+5 date -d @0 +%Z", "-05\n"),
    ("TZ=Europe/Moscow date -d @1340000000 '+%Z %z'", "MSK +0400\n"),
    ("TZ=Europe/Moscow date -d @1276848800 '+%Z %z'", "MSD +0400\n"),
    ("TZ=Europe/Istanbul date -d @1435752000 +%Z; "
     "TZ=Europe/Istanbul date -d @1498906800 +%Z", "EEST\n+03\n"),
])
async def test_date_zone_abbreviation(line, expected):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == (expected, "", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("host_zone,summer,winter", [
    ("America/Los_Angeles", "PDT -0700", "PST -0800"),
    ("Asia/Hong_Kong", "HKT +0800", "HKT +0800"),
    ("UTC", "UTC +0000", "UTC +0000"),
])
async def test_implicit_host_timezone(monkeypatch, host_zone, summer, winter):
    try:
        with monkeypatch.context() as patch:
            patch.setenv("TZ", host_zone)
            time.tzset()
            ws = Workspace({"/": RAMResource()})
            try:
                for epoch, expected in [(1789430400, summer),
                                        (1767225600, winter)]:
                    assert await _run(
                        ws,
                        f"unset TZ; date -d @{epoch} '+%Z %z'") == (expected +
                                                                    "\n", "",
                                                                    0)
                    implicit = await _run(ws, f"unset TZ; date -d @{epoch}")
                    explicit = await _run(ws,
                                          f"TZ={host_zone} date -d @{epoch}")
                    assert implicit == explicit
            finally:
                await ws.close()
    finally:
        time.tzset()


# `date -d` names the refused expression through gnulib's quote(), so a
# byte outside 0x20-0x7e comes back escaped rather than interpolated raw.
# Rows measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
# `bytes` argv (`date -d x<B>`). Mirrored in date.test.ts.
@pytest.mark.asyncio
@pytest.mark.parametrize("line,escaped", [
    ("date -d 'xé'", r"x\303\251"),
    ("date -d $'x\\001'", r"x\001"),
    ("date -d $'x\\177'", r"x\177"),
    ("date -d \"x'\"", r"x\'"),
    ("date -d 'x\\'", r"x\\"),
])
async def test_date_invalid_date_quotes_the_expression(line, escaped):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws,
                          line) == ("", f"date: invalid date '{escaped}'\n", 1)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["date -u -d ''", "date -u -d '   '"])
async def test_an_empty_expression_is_today_at_midnight(line):
    """GNU ACCEPTS an empty (or blank) `-d`, exit 0, at today 00:00:00.

    gnulib's parse-datetime sees no component at all and falls through
    to "a date with no time". Measured on coreutils 9.4 under
    `LC_ALL=C TZ=UTC`: `date -d ''` prints today's date at 00:00:00, and
    so does `date -d '   '`. mirage used to answer
    `date: invalid date ''` and exit 1.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        out, err, code = await _run(ws, f"{line} +%H:%M:%S")
        assert (out, err, code) == ("00:00:00\n", "", 0)
        today, err, code = await _run(ws, f"{line} +%Y-%m-%d")
        now, _, _ = await _run(ws, "date -u +%Y-%m-%d")
        assert (today, err, code) == (now, "", 0)
    finally:
        await ws.close()
