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

from mirage import RAMVFS, MountMode, Workspace


async def _run(ws: Workspace, line: str) -> tuple[str, str, int]:
    io = await ws.shell(line)
    return await io.stdout_str(), await io.stderr_str(), io.exit_code


@pytest.mark.asyncio
async def test_date_honors_the_command_environment_tz():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        line = "TZ=UTC date -d @0 '+%a %Z'"
        assert await _run(ws, line) == ("Thu UTC\n", "", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_tz_never_leaks_between_workspaces():
    # Two workspaces render one instant at once, each under its own TZ:
    # the zone is read from the command environment, never set on the
    # process, so neither can move the other's clock.
    hong_kong = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    utc = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await hong_kong.shell("export TZ=Asia/Hong_Kong")
        await utc.shell("export TZ=UTC")
        line = "date -d @0 '+%H %z'"
        results = await asyncio.gather(
            *[_run(ws, line) for ws in (hong_kong, utc, hong_kong, utc)]
        )
        assert [r[0] for r in results] == [
            "08 +0800\n",
            "00 +0000\n",
            "08 +0800\n",
            "00 +0000\n",
        ]
        plain = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
        try:
            out, _, _ = await _run(plain, "date -u -d @0 '+%H %z'")
            assert out == "00 +0000\n"
        finally:
            await plain.close()
    finally:
        await hong_kong.close()
        await utc.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host_zone,summer,winter",
    [
        ("America/Los_Angeles", "PDT -0700", "PST -0800"),
        ("Asia/Hong_Kong", "HKT +0800", "HKT +0800"),
        ("UTC", "UTC +0000", "UTC +0000"),
    ],
)
async def test_implicit_host_timezone(monkeypatch, host_zone, summer, winter):
    try:
        with monkeypatch.context() as patch:
            patch.setenv("TZ", host_zone)
            time.tzset()
            ws = Workspace({"/": RAMVFS()})
            try:
                for epoch, expected in [
                    (1789430400, summer),
                    (1767225600, winter),
                ]:
                    assert await _run(
                        ws, f"unset TZ; date -d @{epoch} '+%Z %z'"
                    ) == (expected + "\n", "", 0)
                    implicit = await _run(ws, f"unset TZ; date -d @{epoch}")
                    explicit = await _run(
                        ws, f"TZ={host_zone} date -d @{epoch}"
                    )
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
@pytest.mark.parametrize(
    "line,escaped",
    [
        ("date -d 'xé'", r"x\303\251"),
        ("date -d 'x\\'", r"x\\"),
    ],
)
async def test_date_invalid_date_quotes_the_expression(line, escaped):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == (
            "",
            f"date: invalid date '{escaped}'\n",
            1,
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_empty_expression_is_today_at_midnight():
    """GNU ACCEPTS an empty (or blank) `-d`, exit 0, at today 00:00:00.

    gnulib's parse-datetime sees no component at all and falls through
    to "a date with no time". Measured on coreutils 9.4 under
    `LC_ALL=C TZ=UTC`: `date -d ''` prints today's date at 00:00:00, and
    so does `date -d '   '`. mirage used to answer
    `date: invalid date ''` and exit 1.
    """
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        out, err, code = await _run(ws, "date -u -d '' +%H:%M:%S")
        assert (out, err, code) == ("00:00:00\n", "", 0)
        today, err, code = await _run(ws, "date -u -d '' +%Y-%m-%d")
        now, _, _ = await _run(ws, "date -u +%Y-%m-%d")
        assert (today, err, code) == (now, "", 0)
    finally:
        await ws.close()


_AT = "2024-03-05T07:08:09.5Z"
_ISO_VALID = (
    "Valid arguments are:\n  - 'hours'\n  - 'minutes'\n"
    "  - 'date'\n  - 'seconds'\n  - 'ns'\n"
    "Try 'date --help' for more information.\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stderr",
    [
        (
            f"date -d {_AT} -Isu",
            "date: invalid argument 'su' for '--iso-8601'\n" + _ISO_VALID,
        ),
        (
            f"date -d {_AT} -I -R a b",
            "date: multiple output formats specified\n",
        ),
    ],
)
async def test_date_output_format_refusals(line, stderr):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == ("", stderr, 1)
    finally:
        await ws.close()
