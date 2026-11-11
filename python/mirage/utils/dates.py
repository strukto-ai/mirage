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
import json
import logging
import math
import re
from collections.abc import Generator, Mapping
from contextlib import closing
from datetime import datetime, timezone, tzinfo

from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue
from mirage.utils.clock import system_date, system_now
from mirage.utils.timezone import posix_transitions, resolve_tz

logger = logging.getLogger(__name__)


def _date_request(
    header: Mapping[str, JsonValue],
    tz: tzinfo,
    zones: dict[str, tzinfo],
) -> bytes:
    name = header["zone"]
    assert name is None or isinstance(name, str)
    zone = tz
    if name is not None:
        if name not in zones:
            zones[name] = resolve_tz(name)
        zone = zones[name]
    if "year" in header:
        year = header["year"]
        assert isinstance(year, int)
        return json.dumps(posix_transitions(zone, year) or []).encode()
    instant = header["instant"]
    assert isinstance(instant, int)
    moment = datetime.fromtimestamp(instant, zone)
    shift = moment.utcoffset()
    offset = 0 if shift is None else int(shift.total_seconds())
    return json.dumps(
        {"offset": offset, "name": moment.tzname() or ""}
    ).encode()


def clock_reply() -> bytes:
    """The answer to a date stream asking the time, in seconds and
    nanoseconds."""
    return json.dumps(
        divmod(round(system_now() * 1_000_000_000), 1_000_000_000)
    ).encode()


def date_reply(
    header: Mapping[str, JsonValue],
    tz: tzinfo,
    zones: dict[str, tzinfo],
) -> tuple[dict[str, JsonValue], bytes]:
    """The answer to one of a date stream's zone questions.

    Args:
        header (Mapping[str, JsonValue]): the question.
        tz (tzinfo): the command's zone.
        zones (dict[str, tzinfo]): the named zones resolved so far.
    """
    try:
        return {}, _date_request(header, tz, zones)
    except (OverflowError, ValueError, OSError):
        return {"error": "invalid date"}, b""


def _date_steps(
    text: str, mode: str, tz: tzinfo, now: datetime | None
) -> Generator[bytes, None, None]:
    if now is None:
        current, nanos = divmod(
            round(system_now() * 1_000_000_000), 1_000_000_000
        )
    else:
        current = round(now.replace(microsecond=0).timestamp())
        nanos = now.microsecond * 1000
    engine = open_stream(
        "date",
        {
            "text": byte_view(text),
            "mode": mode,
            "now": current,
            "nanos": nanos,
        },
    )
    zones: dict[str, tzinfo] = {}
    while True:
        while engine.busy():
            yield engine.drain()
        taken = engine.request()
        if taken is None:
            break
        header, _ = taken
        yield engine.respond(*date_reply(header, tz, zones))


def _date_result(
    text: str, mode: str, tz: tzinfo, now: datetime | None
) -> dict[str, JsonValue] | None:
    result: dict[str, JsonValue] | None = json.loads(
        b"".join(_date_steps(text, mode, tz, now))
    )
    return result


async def _date_async(
    text: str, mode: str, tz: tzinfo, now: datetime | None
) -> datetime | None:
    try:
        budget = YieldBudget()
        out: list[bytes] = []
        with closing(_date_steps(text, mode, tz, now)) as steps:
            for piece in steps:
                await budget.run()
                out.append(piece)
        return _date_placed(json.loads(b"".join(out)), tz)
    except (OverflowError, ValueError, OSError):
        return None


async def parse_date_expr_async(
    text: str, tz: tzinfo = timezone.utc, now: datetime | None = None
) -> datetime | None:
    """Parse a date expression, yielding between shared-core steps.

    Args:
        text (str): The date expression.
        tz (tzinfo): The result's zone.
        now (datetime | None): The current moment, injectable for tests.
    """
    return await _date_async(text, "expr", tz, now)


async def parse_posix_time_async(
    text: str, *, tz: tzinfo = timezone.utc, now: datetime | None = None
) -> datetime | None:
    """Parse the ``MMDDhhmm[[CC]YY][.ss]`` a bare ``date`` operand is,
    yielding between shared-core steps.

    As GNU date reads it, measured on coreutils 9.7: no year is this year, a
    two-digit one is 2000-2068 up to 68 and 1969-1999 from 69, and ``.ss``
    takes exactly two digits. A field out of range (``1301000024``,
    ``01012500``) is not a date, nor is a wall clock ``tz`` skips; second 60 is
    the next minute's first, as mktime reads a leap second. One divergence: GNU
    shows year 0 and year 10000, where mirage holds what ``datetime`` holds, so
    a year 0 operand, a UTC moment outside years 1-9999 and the leap second
    after 9999-12-31 23:59:59 are not a date either.

    Args:
        text (str): the operand as typed.
        tz (tzinfo): the zone the wall clock is read in.
        now (datetime | None): the current moment, injectable for tests.
    """
    return await _date_async(text, "posix", tz, now)


def _date_placed(
    result: dict[str, JsonValue] | None, tz: tzinfo
) -> datetime | None:
    if result is None:
        return None
    epoch, nanos = result["epoch"], result["nanos"]
    assert isinstance(epoch, int) and isinstance(nanos, int)
    return datetime.fromtimestamp(epoch, tz).replace(microsecond=nanos // 1000)


def parse_date_expr(
    text: str, tz: tzinfo = timezone.utc, now: datetime | None = None
) -> datetime | None:
    """Parse a free-form date expression as ``date -d`` reads it.

    The grammar is coreutils 9.7's as measured on debian:stable-slim:
    calendar dates (``2026-01-15``, ``1/15/26``, ``15 Jan 2026``,
    ``Jan 15, 2026``, ``20260115``), times of day (``10:30:45.5``,
    ``9pm``) with zone corrections (``+05:30``), zone names (``UTC``,
    ``EST DST``, ``UTC+3``, military letters), days of the week
    (``next monday``), relative items (``2 days ago``, ``tomorrow``),
    ``@epoch`` and a leading ``TZ="zone"``, with parenthesized comments
    ignored. None is date's ``invalid date``; mirage also refuses a
    moment outside years 1-9999, which date shows.

    Args:
        text (str): the expression.
        tz (tzinfo): the zone it is read and returned in.
        now (datetime | None): the current moment, injectable for tests;
            a naive one is the host's local time.
    """
    try:
        return _date_placed(_date_result(text, "expr", tz, now), tz)
    except (OverflowError, ValueError, OSError):
        return None


def utc_date_folder(ts: float) -> str:
    """The UTC day ``ts`` falls on, as ``YYYY-MM-DD``.

    Args:
        ts (float): seconds since the unix epoch.
    """
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def iso_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def timestamp_iso(epoch: float | None) -> str | None:
    """Spell an epoch seconds value the way the setattr op reads times.

    The inverse of ``iso_timestamp``. A guest hands `os.utime` epoch
    floats and the op takes ISO text, so the conversion lives here
    rather than in each runtime surface.

    Args:
        epoch (float | None): seconds since the epoch, or None.

    Returns:
        str | None: UTC ISO text, or None when there is no time.
    """
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def in_mtime_window(
    timestamp: float | None, mtime_min: float | None, mtime_max: float | None
) -> bool:
    if mtime_min is None and mtime_max is None:
        return True
    if timestamp is None:
        return False
    if mtime_min is not None and timestamp < mtime_min:
        return False
    if mtime_max is not None and timestamp > mtime_max:
        return False
    return True


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def now_iso() -> str:
    return to_iso_z(system_date())


def ns_to_iso(ns: int) -> str:
    """Spell a host file time in UTC to the millisecond, as Node's stat does.

    Node renders a stat time as ``Date(Math.round(sec * 1e3 + nsec / 1e6))``;
    rounding the same double here keeps a disk mount's times byte-identical
    across hosts, and the fraction is what ``find -newer`` compares.

    Args:
        ns (int): unix epoch nanoseconds (``st_mtime_ns``).
    """
    sec, nsec = divmod(ns, 1_000_000_000)
    whole, ms = divmod(math.floor(sec * 1e3 + nsec / 1e6 + 0.5), 1000)
    stamp = datetime.fromtimestamp(whole, tz=timezone.utc)
    return f"{stamp:%Y-%m-%dT%H:%M:%S}.{ms:03d}Z"


# An ISO 8601 date-time as backends spell one: a date, an optional time
# with optional seconds and fraction, and an optional offset.
_DATE_TIME = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})"
    r"(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?"
    r"(Z|[+-]\d{2}:?\d{2})?"
)


def ms_to_rfc3339(ms: float) -> str:
    """An instant as RFC 3339 text in UTC to the millisecond, as the HTTP
    API reports every time: ``2026-11-11T07:24:14.062Z``. Rounds as
    TypeScript's ``msToRfc3339`` does, so both hosts spell it alike.

    Args:
        ms (float): unix epoch milliseconds.
    """
    whole, frac = divmod(math.floor(ms + 0.5), 1000)
    stamp = datetime.fromtimestamp(whole, tz=timezone.utc)
    return f"{stamp:%Y-%m-%dT%H:%M:%S}.{frac:03d}Z"


def rfc3339_of(text: str | None) -> str | None:
    """A backend's date-time text as RFC 3339 in UTC to the millisecond,
    or None when it is not an ISO 8601 date-time. A time with no offset
    is read as UTC, digits past the millisecond are dropped, and only
    this one grammar is read, so both hosts agree on every input.

    Args:
        text (str | None): the backend's text.
    """
    if not text:
        return None
    m = _DATE_TIME.fullmatch(text)
    if m is None:
        return None
    year, month, day, hour, minute, second, fraction, offset = m.groups()
    if int(year) < 1000:
        return None
    try:
        moment = datetime(
            int(year),
            int(month),
            int(day),
            int(hour or 0),
            int(minute or 0),
            int(second or 0),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    ms = int(moment.timestamp()) * 1000 + int(
        (fraction or "")[:3].ljust(3, "0")
    )
    if offset and offset != "Z":
        sign = -1 if offset[0] == "-" else 1
        digits = offset[1:].replace(":", "")
        ms -= sign * (int(digits[:2]) * 60 + int(digits[2:])) * 60_000
    return ms_to_rfc3339(ms)


def epoch_to_iso(seconds: float) -> str:
    """Convert unix epoch seconds to a second-precision UTC ISO-8601 string.

    Floored to whole seconds (matching the TypeScript ``Math.floor``) so
    the two converters produce byte-identical output for negative
    (pre-1970) fractional timestamps as well.

    Args:
        seconds (float): unix epoch seconds (sub-second part is dropped).
    """
    return to_iso_z(
        datetime.fromtimestamp(math.floor(seconds), tz=timezone.utc)
    )


def iso_to_epoch(iso: str) -> int:
    """Convert an ISO-8601 string to whole unix epoch seconds.

    The inverse of epoch_to_iso; a naive stamp (no offset, e.g. a
    ``touch -t`` overlay time) is read as UTC so Python and TypeScript
    agree. Floored to whole seconds (matching the TypeScript
    ``Math.floor``) so a negative fractional epoch yields the same value
    in both languages.

    Args:
        iso (str): ISO-8601 timestamp, with or without a ``Z``/offset.
    """
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.floor(dt.timestamp())


def stat_epoch(modified: str | None) -> int | None:
    """A stat's modification time in epoch seconds, None where it holds no
    date; a backend can answer with an empty string.

    Args:
        modified (str | None): the stat's ``modified`` field.
    """
    if not modified:
        return None
    try:
        return iso_to_epoch(modified)
    except ValueError as exc:
        logger.debug("no date in %r: %s", modified, exc)
        return None
