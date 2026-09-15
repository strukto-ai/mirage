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

import re
from calendar import monthrange
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TZ_VAR = "TZ"

# A POSIX TZ name: `<...>` quotes three or more letters, digits and
# signs (`<+0530>`), and a bare name is three or more letters (`EST`).
_NAME_RE = re.compile(r"<([+\-0-9A-Za-z]{3,})>|([A-Za-z]{3,})")
# An unsigned `h[:m[:s]]` as glibc's `%hu:%hu:%hu` reads it: each field
# takes any run of digits, and a colon with no digits after it ends the
# number there.
_CLOCK_RE = re.compile(r"(\d+)(?::(\d+))?(?::(\d+))?")
_DIGITS_RE = re.compile(r"\d+")
# `Mm.w.d`, read as far as it goes: `M3` and `M3.5` are the partial
# reads glibc keeps when it refuses the rule.
_MONTH_RULE_RE = re.compile(r"M(?:(\d+)(?:\.(\d+)(?:\.(\d+))?)?)?")
_HOUR = 3600
_DAY = timedelta(days=1)
# glibc clamps a POSIX offset at 24 hours (`UTC24`, and `UTC99` reads
# the same), one second past what a tzinfo may carry, so both mirage
# hosts stop there: `TZ=UTC24 date -d @0 +%z` is `-2359` here, `-2400`
# under GNU, and the wall clock lands one second later.
_MAX_OFFSET = 24 * _HOUR - 1
# The window zone_abbreviations samples: tzdata's post-1970 rules, up to
# the 32-bit horizon every zone's rules are laid out to.
_ABBREV_SAMPLE_START = datetime(1970, 1, 1, tzinfo=timezone.utc)
_ABBREV_SAMPLE_END = datetime(2038, 1, 1, tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class TransitionRule:
    """One POSIX DST transition, ``Mm.w.d``, ``Jn`` or ``n``, with the
    local time of day it happens at.

    The fields hold what glibc read, which for a rule it refused may
    sit outside POSIX's ranges (see ``_read_rule``); ``at`` then counts
    the way glibc's arithmetic does.

    Args:
        kind (str): ``M`` for month/week/weekday, ``J`` for a Julian
            day that never counts February 29, ``D`` for a zero-based
            day of the year that does.
        month (int): the month for an ``M`` rule, 1 to 12.
        week (int): the week for an ``M`` rule, 1 to 5, where 5 is the
            last such weekday of the month; 0 counts as 1.
        weekday (int): the weekday for an ``M`` rule, 0 for Sunday; a
            value past 6 counts on from the month's first Sunday.
        day (int): the day for a ``J`` (1 to 365) or ``D`` (0 to 365)
            rule; ``J`` day 0 is the day before January 1.
        seconds (int): the time of day, in seconds, which POSIX lets run
            past a day in either direction (``/-1``, ``/25``).
    """

    kind: str
    month: int = 0
    week: int = 0
    weekday: int = 0
    day: int = 0
    seconds: int = 2 * _HOUR

    def at(self, year: int) -> datetime:
        """The transition's wall-clock moment in ``year``.

        Args:
            year (int): the calendar year.
        """
        if self.kind == "M":
            first = datetime(year, self.month, 1)
            # Python counts Monday as 0; POSIX counts Sunday as 0.
            day = self.weekday - (first.weekday() + 1) % 7
            if day < 0:
                day += 7
            days = monthrange(year, self.month)[1]
            for _ in range(1, self.week):
                if day + 7 >= days:
                    break
                day += 7
            date = first + timedelta(days=day)
        elif self.kind == "J":
            date = datetime(year, 1, 1) + timedelta(days=self.day - 1)
            leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
            if leap and self.day >= 60:
                date += _DAY
        else:
            date = datetime(year, 1, 1) + timedelta(days=self.day)
        return date + timedelta(seconds=self.seconds)


# The rules glibc applies when a DST name comes with no `,rule`, or one
# clause is missing: the US transitions, second Sunday of March and
# first Sunday of November, at 02:00.
_US_RULES = (TransitionRule("M", month=3, week=2, weekday=0),
             TransitionRule("M", month=11, week=1, weekday=0))
# What glibc leaves in a rule it refused: the state it zeroed before
# reading, day 0 of the year at 00:00, or, once it had read a `J`,
# Julian day 0, the day before January 1.
_ZERO_RULE = TransitionRule("D", day=0, seconds=0)
_REFUSED_JULIAN = TransitionRule("J", day=0, seconds=0)


class PosixZone(tzinfo):
    """A zone read from a POSIX TZ string with a DST half
    (``CET-1CEST,M3.5.0,M10.5.0/3``), the way glibc reads one.

    The two offsets and the two rules decide everything: an instant is
    in DST when it lies between the start transition, given in standard
    wall time, and the end transition, given in DST wall time, both laid
    out in the year the UTC clock reads, with the window wrapping the
    year in the southern hemisphere and empty when the two coincide. A
    wall clock that two instants share (the hour repeated at the end of
    DST) resolves to the first of them unless ``fold`` says otherwise,
    and one no instant shows (the hour skipped at its start) reads under
    the standard offset, which are Python's own conventions for a
    ``tzinfo``. The DST half may be nameless with a zero offset, which
    is what glibc keeps when it cannot read its name.

    Args:
        std (str): the standard-time abbreviation.
        std_offset (timedelta): the standard offset from UTC.
        dst (str): the daylight-time abbreviation.
        dst_offset (timedelta): the daylight offset from UTC.
        start (TransitionRule): when DST starts, in standard wall time.
        end (TransitionRule): when DST ends, in daylight wall time.
    """

    def __init__(self, std: str, std_offset: timedelta, dst: str,
                 dst_offset: timedelta, start: TransitionRule,
                 end: TransitionRule) -> None:
        self._std = std
        self._std_offset = std_offset
        self._dst = dst
        self._dst_offset = dst_offset
        self._start = start
        self._end = end

    def _in_dst(self, utc: datetime) -> bool:
        """Whether DST is in effect at a naive UTC moment.

        Args:
            utc (datetime): the moment, naive, on the UTC clock.
        """
        start = self._start.at(utc.year) - self._std_offset
        end = self._end.at(utc.year) - self._dst_offset
        if start <= end:
            return start <= utc < end
        return not end <= utc < start

    def _resolves_dst(self, dt: datetime) -> bool:
        """Whether a wall-clock reading resolves to daylight time.

        Decided by the rules, never by the offsets, which glibc lets
        coincide (``CET-1CEST-1,...``) while still naming the halves.

        Args:
            dt (datetime): the wall clock, whose ``fold`` picks the later
                of two instants sharing it.
        """
        wall = dt.replace(tzinfo=None)
        as_std = not self._in_dst(wall - self._std_offset)
        as_dst = self._in_dst(wall - self._dst_offset)
        return as_dst and (not as_std or dt.fold == 0)

    def utcoffset(self, dt: datetime | None) -> timedelta:
        if dt is not None and self._resolves_dst(dt):
            return self._dst_offset
        return self._std_offset

    def dst(self, dt: datetime | None) -> timedelta:
        if dt is None or not self._resolves_dst(dt):
            return timedelta(0)
        return self._dst_offset - self._std_offset

    def tzname(self, dt: datetime | None) -> str:
        if dt is not None and self._resolves_dst(dt):
            return self._dst
        return self._std

    def fromutc(self, dt: datetime) -> datetime:
        utc = dt.replace(tzinfo=None)
        in_dst = self._in_dst(utc)
        wall = utc + (self._dst_offset if in_dst else self._std_offset)
        # The second reading of a repeated hour: a standard-time wall
        # clock that would also have resolved as daylight time.
        fold = int(not in_dst and self._in_dst(wall - self._dst_offset))
        return wall.replace(tzinfo=self, fold=fold)

    def __repr__(self) -> str:
        return (f"PosixZone({self._std!r}, {self._std_offset!r}, "
                f"{self._dst!r}, {self._dst_offset!r})")


def zone_from_env(env: Mapping[str, str] | None) -> tzinfo | None:
    """The zone a command environment's ``TZ`` names.

    None when ``TZ`` is unset (or there is no environment), which means
    the host's local zone, the way a naive ``datetime`` does. The value
    is read from the command's own environment, never from the process
    (``os.environ``, ``time.tzset``), so two workspaces running at once
    each see their own ``TZ`` and neither moves the host's clock.

    Args:
        env (Mapping[str, str] | None): the command environment.
    """
    if env is None:
        return None
    spec = env.get(TZ_VAR)
    if spec is None:
        return None
    return resolve_tz(spec)


def resolve_tz(spec: str) -> tzinfo:
    """The zone a ``TZ`` value names, read as glibc's ``tzset`` reads it.

    A leading colon is dropped. An empty value is UTC. A name tzdata
    knows (``Asia/Hong_Kong``, ``UTC``, ``EST5EDT``) is that zone.
    Anything else is a POSIX TZ string (``UTC0``, ``JST-9``,
    ``<+0530>-5:30``, ``CET-1CEST,M3.5.0,M10.5.0/3``), where a bare name
    with no offset is UTC under that name, which is how glibc renders
    ``TZ=Bogus/Zone`` (``+0000 Bogus``), and a name shorter than three
    letters is refused, leaving ``%Z`` empty.

    Args:
        spec (str): the value of ``TZ``.
    """
    name = spec[1:] if spec.startswith(":") else spec
    if not name:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return posix_zone(name)


def _read_name(spec: str, pos: int) -> tuple[str, int]:
    """Read a POSIX TZ name at ``pos``: the name and the position after
    it, or an empty name and ``pos`` when none starts there.

    Args:
        spec (str): the TZ string.
        pos (int): where to read.
    """
    match = _NAME_RE.match(spec, pos)
    if match is None:
        return "", pos
    return match.group(1) or match.group(2), match.end()


def _read_clock(spec: str,
                pos: int) -> tuple[tuple[int, int, int] | None, int]:
    """Read an unsigned ``h[:m[:s]]`` at ``pos`` as glibc's
    ``%hu:%hu:%hu`` does: the three fields and the position after them,
    or None and ``pos`` when no digit starts there.

    Args:
        spec (str): the TZ string.
        pos (int): where to read.
    """
    match = _CLOCK_RE.match(spec, pos)
    if match is None:
        return None, pos
    hours, minutes, seconds = match.groups()
    return (int(hours), int(minutes or 0), int(seconds or 0)), match.end()


def _read_offset(spec: str, pos: int, dst: bool) -> tuple[int | None, int]:
    """Read a POSIX offset at ``pos`` as glibc's ``parse_offset`` does:
    seconds west of Greenwich, and the position after it.

    A standard offset must start with a sign or a digit and read at
    least an hour, else there is none (None, and ``pos`` unmoved). A
    daylight offset takes a sign even when no hours follow, and reads
    as None then, past the sign, for the caller to default. Hours are
    clamped at 24 and minutes and seconds at 59, glibc's
    ``compute_offset``.

    Args:
        spec (str): the TZ string.
        pos (int): where to read.
        dst (bool): whether this is the daylight half's offset.
    """
    head = spec[pos:pos + 1]
    if not dst and not (head in ("+", "-") or head.isdigit()):
        return None, pos
    sign = 1
    if head in ("+", "-"):
        sign = -1 if head == "-" else 1
        pos += 1
    clock, end = _read_clock(spec, pos)
    if clock is None:
        return None, pos
    hours, minutes, seconds = clock
    west = min(hours, 24) * _HOUR + min(minutes, 59) * 60 + min(seconds, 59)
    return sign * west, end


def _bounded(seconds: int) -> int:
    """An offset a tzinfo can carry: within a day, one second short.

    Args:
        seconds (int): the offset, east positive.
    """
    return max(-_MAX_OFFSET, min(_MAX_OFFSET, seconds))


def _read_rule(spec: str, pos: int,
               which: int) -> tuple[TransitionRule, int, bool]:
    """Read one transition rule at ``pos`` as glibc's ``parse_rule`` does.

    An optional comma leads. ``Jn`` and ``n`` take a day, ``Mm.w.d`` a
    month, week and weekday, and the end of the string stands for the
    US rule of that half; ``/time`` may follow, ``h[:m[:s]]`` with an
    optional ``-``, and is two o'clock when absent or unreadable. glibc
    refuses a day past 365, ``J0``, a month outside 1 to 12, a week
    outside 1 to 5, a weekday past 6, anything else where a rule should
    start, and anything but ``/``, ``,`` or the end after the date part;
    it keeps what it had read so far, and the time of day, which comes
    last, is still zero then. The refused rule comes back as glibc
    leaves it, except that a month outside its table (which glibc reads
    past) is the refused Julian rule here; the second rule is then
    never read (see ``posix_zone``).

    Args:
        spec (str): the TZ string.
        pos (int): where the rule starts.
        which (int): 0 for the start of DST, 1 for its end.

    Returns:
        tuple[TransitionRule, int, bool]: the rule, the position after
        it, and whether glibc accepts it.
    """
    if spec[pos:pos + 1] == ",":
        pos += 1
    head = spec[pos:pos + 1]
    if head == "J" or head.isdigit():
        kind = "J" if head == "J" else "D"
        refused = _REFUSED_JULIAN if kind == "J" else _ZERO_RULE
        match = _DIGITS_RE.match(spec, pos + (kind == "J"))
        if match is None:
            return refused, pos, False
        day = int(match.group())
        if day > 365 or (kind == "J" and day == 0):
            return refused, pos, False
        rule = TransitionRule(kind, day=day, seconds=0)
        pos = match.end()
    elif head == "M":
        match = _MONTH_RULE_RE.match(spec, pos)
        assert match is not None
        month, week, weekday = (int(field or 0) for field in match.groups())
        rule = TransitionRule("M",
                              month=month,
                              week=week,
                              weekday=weekday,
                              seconds=0)
        if not 1 <= month <= 12:
            return _REFUSED_JULIAN, pos, False
        if None in match.groups() or not 1 <= week <= 5 or weekday > 6:
            return rule, pos, False
        pos = match.end()
    elif not head:
        rule = _US_RULES[which]
    else:
        return _ZERO_RULE, pos, False
    tail = spec[pos:pos + 1]
    if tail not in ("", "/", ","):
        return rule, pos, False
    seconds = 2 * _HOUR
    if tail == "/":
        pos += 1
        if pos == len(spec):
            return rule, pos, False
        negative = spec[pos] == "-"
        pos += negative
        clock, pos = _read_clock(spec, pos)
        hours, minutes, secs = clock if clock is not None else (2, 0, 0)
        seconds = (-1 if negative else 1) * (hours * _HOUR + minutes * 60 +
                                             secs)
    return replace(rule, seconds=seconds), pos, True


def posix_zone(spec: str) -> tzinfo:
    """The zone a POSIX TZ string names, read as glibc's ``tzset`` reads
    one.

    The grammar is ``std[offset[dst[offset][,start[/time],end[/time]]]]``.
    POSIX counts an offset west of Greenwich as positive, so ``EST5`` is
    five hours behind UTC; a missing standard offset is zero and ends
    the reading (``Bogus/Zone`` is UTC under that name), and a missing
    daylight offset is one hour ahead of standard. What glibc cannot
    read it keeps rather than drops. A string with no name at all is UTC
    with no abbreviation. A daylight half whose name it cannot read is
    nameless UTC, so ``EST5x`` renders ``+0000`` with an empty ``%Z``
    nearly all year, its rules being the zero ones. A rule it refuses
    is kept as far as it was read and the rule after it is never read,
    so ``CET-1CEST,bogus`` is CEST almost all year and
    ``CET-1CEST,M3.5.0,M13.1.0`` is CEST from late March to the year's
    end. A rule that is missing is the US one for that half; glibc
    consults a ``posixrules`` file for that on hosts that ship one,
    which is not mirrored.

    Args:
        spec (str): the TZ string, colon already dropped.
    """
    std, pos = _read_name(spec, 0)
    if not std:
        return timezone(timedelta(0), "")
    west, pos = _read_offset(spec, pos, dst=False)
    if west is None or pos == len(spec):
        return timezone(timedelta(seconds=_bounded(-(west or 0))), std)
    std_offset = _bounded(-west)
    dst, pos = _read_name(spec, pos)
    dst_offset = 0
    if dst:
        dst_west, pos = _read_offset(spec, pos, dst=True)
        dst_offset = _bounded(std_offset +
                              _HOUR if dst_west is None else -dst_west)
    start, pos, accepted = _read_rule(spec, pos, 0)
    end = _read_rule(spec, pos, 1)[0] if accepted else _ZERO_RULE
    return PosixZone(std, timedelta(seconds=std_offset), dst,
                     timedelta(seconds=dst_offset), start, end)


def numeric_abbreviation(offset: int) -> str:
    """The abbreviation tzdata gives an offset it has no letters for.

    Since 2017 tzdata names such a zone by its offset, ``+08``, ``-03``
    or ``+0530``, with minutes only when they are not zero.

    Args:
        offset (int): the UTC offset in seconds, east positive.
    """
    sign = "-" if offset < 0 else "+"
    hours, rest = divmod(abs(offset), _HOUR)
    minutes = rest // 60
    return f"{sign}{hours:02d}" + (f"{minutes:02d}" if minutes else "")


def _reading(zone: ZoneInfo, at: datetime) -> tuple[int, str]:
    """The offset and abbreviation ``zone`` shows at ``at``.

    Args:
        zone (ZoneInfo): the zone.
        at (datetime): an aware moment.
    """
    local = at.astimezone(zone)
    offset = local.utcoffset()
    return (0 if offset is None else int(offset.total_seconds()),
            local.tzname() or "")


def _first_shown(zone: ZoneInfo, before: datetime, after: datetime,
                 reading: tuple[int, str]) -> datetime:
    """The first second in ``(before, after]`` at which ``zone`` shows
    ``reading``, by bisection: it shows something else at ``before``
    and ``reading`` at ``after``.

    Args:
        zone (ZoneInfo): the zone.
        before (datetime): a moment showing another reading.
        after (datetime): a moment showing ``reading``.
        reading (tuple[int, str]): the offset and abbreviation sought.
    """
    while after - before > timedelta(seconds=1):
        middle = before + (after - before) // 2
        if _reading(zone, middle) == reading:
            after = middle
        else:
            before = middle
    return after


def zone_abbreviations(name: str,
                       step: timedelta = _DAY) -> list[tuple[int, str, int]]:
    """The abbreviations a tzdata zone has carried since 1970, and when.

    Sampled once per ``step`` from 1970 to 2038 (every daylight period
    lasts weeks, and every change of standard time longer), and the
    moment each new name took effect is then found to the second
    between the two samples around it. A zone gets a row each time an
    offset it shows changes its name: Moscow's +04 was ``MSD`` in the
    summers before 2011 and ``MSK`` from 2011-03-27, and Istanbul's +03
    was ``EEST`` in summers and ``+03`` since 2016. An offset tzdata
    only ever spelled out (``+08``) has no rows, since
    ``numeric_abbreviation`` rebuilds that; one that carried letters at
    some time keeps every name it carried. This is the table the
    TypeScript twin ships for ``%Z``, because Intl offers no tzdata
    names.

    Args:
        name (str): a tzdata zone name.
        step (timedelta): the sampling interval.

    Returns:
        list[tuple[int, str, int]]: ``(offset_seconds, abbreviation,
        since_epoch)`` rows in the order the names took effect; the rows
        in effect at 1970 carry 0.
    """
    zone = ZoneInfo(name)
    rows: list[tuple[int, str, int]] = []
    current: dict[int, str] = {}
    previous = at = _ABBREV_SAMPLE_START
    while at < _ABBREV_SAMPLE_END:
        reading = _reading(zone, at)
        offset, abbrev = reading
        if current.get(offset) != abbrev:
            since = at if at == previous else _first_shown(
                zone, previous, at, reading)
            rows.append((offset, abbrev, int(since.timestamp())))
            current[offset] = abbrev
        previous = at
        at += step
    lettered = {
        offset
        for offset, abbrev, _ in rows if abbrev != numeric_abbreviation(offset)
    }
    return [row for row in rows if row[0] in lettered]
