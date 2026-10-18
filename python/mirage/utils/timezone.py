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

from calendar import monthrange, timegm
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TZ_VAR = "TZ"

_HOUR = 3600
_DAY = timedelta(days=1)

# Character classes of a POSIX TZ string, ASCII only as in the C locale:
# `ÄBC5` has no name GNU accepts.
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_DIGITS = "0123456789"
_QUOTABLE = _LETTERS + _DIGITS + "+-"
_BLANKS = " \t\n\v\f\r"
_SIGNS = "+-"

# A numeric field holds 16 bits: `65536` reads as 0, `-5` as 65531, and
# anything past 2**64 - 1 as 65535.
_FIELD_SPAN = 0x10000
_FIELD_CEILING = "18446744073709551615"

# GNU prints offsets up to ±24:59:59; a Python tzinfo must stay inside a
# day, so both hosts stop one second short of it.
_OFFSET_LIMIT = 24 * _HOUR - 1

# The window zone_abbreviations samples: tzdata's post-1970 rules, up to
# the 32-bit horizon every zone's rules are laid out to.
_ABBREV_SAMPLE_START = datetime(1970, 1, 1, tzinfo=timezone.utc)
_ABBREV_SAMPLE_END = datetime(2038, 1, 1, tzinfo=timezone.utc)


def _weekday_in_month(year: int, month: int, week: int, weekday: int) -> date:
    """The day an ``Mm.w.d`` rule names.

    POSIX: week 1 holds the first ``weekday`` of the month and week 5
    the last. Measured on GNU date 9.7 beyond that: week 0 reads as 1
    and a week past the last occurrence as the last one; a weekday past
    6 counts that many days from the Sunday that opens the month's first
    week (M9.1.7 is 2024-09-08, as September 2024 starts on a Sunday),
    and a count that runs past the month stays there (M3.5.100 is
    2024-06-04).

    Args:
        year (int): the calendar year.
        month (int): the month, 1 to 12.
        week (int): the week as read.
        weekday (int): the weekday as read, 0 for Sunday.
    """
    first = date(year, month, 1)
    opens_on = first.isoweekday() % 7
    if weekday <= 6:
        offset = (weekday - opens_on) % 7
    else:
        offset = weekday - opens_on
    last = monthrange(year, month)[1] - 1
    # How many of that day the month holds from the first one on: one
    # even when the first already runs past the month.
    held = 1 + max(0, (last - offset) // 7)
    nth = min(max(week, 1), held)
    return first + timedelta(days=offset + 7 * (nth - 1))


def _julian_date(year: int, day: int) -> date:
    """The day a ``Jn`` rule names: the ``day``-th of a year counted as
    if February always had 28 days, so ``J60`` is March 1 in every year;
    day 0 is December 31 of the year before.

    Args:
        year (int): the calendar year.
        day (int): the day as read, 0 to 365.
    """
    if day == 0:
        return date(year, 1, 1) - _DAY
    # 2001 has no February 29, so its calendar is the one J counts in.
    common = date(2001, 1, 1) + timedelta(days=day - 1)
    return date(year, common.month, common.day)


@dataclass(frozen=True, slots=True)
class TransitionRule:
    """One POSIX DST transition, ``Mm.w.d``, ``Jn`` or ``n``, with the
    local time of day it happens at.

    A rule GNU date refused keeps the fields read of it (see
    ``_weekday_rule``), which may sit outside POSIX's ranges; ``at``
    places those where GNU date 9.7 was measured to put them.

    Args:
        kind (str): ``M`` for month/week/weekday, ``J`` for a Julian
            day that never counts February 29, ``D`` for a zero-based
            day of the year that does.
        month (int): the month for an ``M`` rule, 1 to 12.
        week (int): the week for an ``M`` rule, 1 to 5, where 5 is the
            last such weekday of the month; 0 counts as 1, and a week
            past the last occurrence as the last.
        weekday (int): the weekday for an ``M`` rule, 0 for Sunday; a
            value past 6 counts on from the Sunday that opens the
            month's first week.
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
            day = _weekday_in_month(year, self.month, self.week, self.weekday)
        elif self.kind == "J":
            day = _julian_date(year, self.day)
        else:
            day = date(year, 1, 1) + timedelta(days=self.day)
        midnight = datetime(day.year, day.month, day.day)
        return midnight + timedelta(seconds=self.seconds)


# What a DST zone falls back to when its string names no rule, or only a
# start: DST from 02:00 on the second Sunday of March to 02:00 on the
# first Sunday of November.
_FALLBACK_START = TransitionRule("M", month=3, week=2, weekday=0)
_FALLBACK_END = TransitionRule("M", month=11, week=1, weekday=0)
# A rule GNU never read sits at midnight on January 1; a `J` or `Mm` rule
# whose day or month it refused at midnight on the day before.
_UNREAD_RULE = TransitionRule("D", day=0, seconds=0)
_DAY_BEFORE_YEAR = TransitionRule("J", day=0, seconds=0)


class PosixZone(tzinfo):
    """A zone read from a POSIX TZ string with a DST half
    (``CET-1CEST,M3.5.0,M10.5.0/3``).

    The two offsets and the two rules decide everything, as measured on
    GNU date 9.7: both of a year's transitions are laid out in the year
    the UTC clock reads, the start in standard wall time and the end in
    DST wall time, and an instant shows the state the latest of them up
    to it set, or, before either, the state the year ends in, so a
    southern window wraps the new year and two transitions at one
    instant leave DST off. A wall clock that two instants share (the
    hour repeated at the end of DST) resolves to the first of them
    unless ``fold`` says otherwise, and one no instant shows (the hour
    skipped at its start) reads under the standard offset, which are
    Python's own conventions for a ``tzinfo``. The DST half may be
    nameless with a zero offset, which is what GNU date shows when it
    cannot read that name.

    Args:
        std (str): the standard-time abbreviation.
        std_offset (timedelta): the standard offset from UTC.
        dst (str): the daylight-time abbreviation.
        dst_offset (timedelta): the daylight offset from UTC.
        start (TransitionRule): when DST starts, in standard wall time.
        end (TransitionRule): when DST ends, in daylight wall time.
    """

    def __init__(
        self,
        std: str,
        std_offset: timedelta,
        dst: str,
        dst_offset: timedelta,
        start: TransitionRule,
        end: TransitionRule,
    ) -> None:
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
        # The year's two changes in order, an end after a start at the
        # same instant: the latest one passed sets the state, and before
        # either the year's last change still holds from the year before.
        early, late = (start, True), (end, False)
        if end < start:
            early, late = late, early
        if utc >= late[0]:
            return late[1]
        return early[1] if utc >= early[0] else late[1]

    def _resolves_dst(self, dt: datetime) -> bool:
        """Whether a wall-clock reading resolves to daylight time.

        Decided by the rules, never by the offsets, which GNU date lets
        coincide (``CET-1CEST-1,...``) while still naming the halves.

        Args:
            dt (datetime): the wall clock, whose ``fold`` picks the later
                of two instants sharing it.
        """
        wall = dt.replace(tzinfo=None)
        as_std = not self._in_dst(wall - self._std_offset)
        as_dst = self._in_dst(wall - self._dst_offset)
        return as_dst and (not as_std or dt.fold == 0)

    def transitions(self, year: int) -> tuple[int, int]:
        """When daylight saving time starts and ends in a UTC year, as
        epoch seconds: the instants the two rules lay out in the year the
        UTC clock reads, the end first when the window wraps the year and
        the two equal when it is empty.

        Args:
            year (int): the UTC year.
        """
        start = self._start.at(year) - self._std_offset
        end = self._end.at(year) - self._dst_offset
        return timegm(start.timetuple()), timegm(end.timetuple())

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
        return (
            f"PosixZone({self._std!r}, {self._std_offset!r}, "
            f"{self._dst!r}, {self._dst_offset!r})"
        )


def posix_transitions(zone: tzinfo, year: int) -> tuple[int, int] | None:
    """When a POSIX TZ zone's daylight saving time starts and ends in a
    UTC year (see PosixZone.transitions), None for any other zone, whose
    transitions come from tzdata.

    Args:
        zone (tzinfo): the zone.
        year (int): the UTC year.
    """
    return zone.transitions(year) if isinstance(zone, PosixZone) else None


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
    """The zone a ``TZ`` value names, read as GNU date 9.7 reads it.

    A leading colon is dropped. An empty value is UTC. A name tzdata
    knows (``Asia/Hong_Kong``, ``UTC``, ``EST5EDT``) is that zone.
    Anything else is a POSIX TZ string (``UTC0``, ``JST-9``,
    ``<+0530>-5:30``, ``CET-1CEST,M3.5.0,M10.5.0/3``), where a bare name
    with no offset is UTC under that name, which is how GNU date renders
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


def _span_of(spec: str, pos: int, chars: str) -> int:
    """Where the run of ``chars`` starting at ``pos`` ends.

    Args:
        spec (str): the TZ string.
        pos (int): where the run starts.
        chars (str): the characters the run may hold.
    """
    while pos < len(spec) and spec[pos] in chars:
        pos += 1
    return pos


def _number_field(spec: str, pos: int) -> tuple[int, int] | None:
    """A numeric field of an offset, a rule time or an ``M`` rule.

    GNU skips blanks before the digits and takes one sign, then keeps
    the value in 16 bits: ``UTC65559`` is -23:00, ``UTC--65535`` (the
    offset's sign, then -65535) is +01:00, and ``UTC99999999999999999999``
    reads its hours as 65535. None when no digit follows.

    Args:
        spec (str): the TZ string.
        pos (int): where the field starts.

    Returns:
        tuple[int, int] | None: the value, 0 to 65535, and the position
        after its digits.
    """
    start = _span_of(spec, pos, _BLANKS)
    negative = spec.startswith("-", start)
    if spec.startswith(tuple(_SIGNS), start):
        start += 1
    stop = _span_of(spec, start, _DIGITS)
    if stop == start:
        return None
    digits = spec[start:stop].lstrip("0")
    if len(digits) > len(_FIELD_CEILING) or (
        len(digits) == len(_FIELD_CEILING) and digits > _FIELD_CEILING
    ):
        return _FIELD_SPAN - 1, stop
    value = 0
    for digit in digits:
        value = (value * 10 + int(digit)) % _FIELD_SPAN
    return (-value if negative else value) % _FIELD_SPAN, stop


def _clock_fields(spec: str, pos: int) -> tuple[list[int], int] | None:
    """``hh[:mm[:ss]]``, each a numeric field.

    A colon with no field after it is left unread, so ``UTC5:`` is
    -05:00 followed by ``:``. None when there are no hours.

    Args:
        spec (str): the TZ string.
        pos (int): where the hours start.

    Returns:
        tuple[list[int], int] | None: hours, minutes and seconds (0 when
        absent), and the position after the last field read.
    """
    hours = _number_field(spec, pos)
    if hours is None:
        return None
    fields = [hours[0]]
    pos = hours[1]
    while len(fields) < 3 and spec.startswith(":", pos):
        more = _number_field(spec, pos + 1)
        if more is None:
            break
        fields.append(more[0])
        pos = more[1]
    return fields + [0] * (3 - len(fields)), pos


def _zone_name(spec: str, pos: int) -> tuple[str, int] | None:
    """An abbreviation: three or more ASCII letters, or three or more of
    letters, digits, ``+`` and ``-`` between ``<`` and ``>``.

    Args:
        spec (str): the TZ string.
        pos (int): where the name starts.

    Returns:
        tuple[str, int] | None: the name and the position after it, or
        None when there is no name GNU accepts there.
    """
    if spec.startswith("<", pos):
        stop = _span_of(spec, pos + 1, _QUOTABLE)
        if stop - pos - 1 < 3 or not spec.startswith(">", stop):
            return None
        return spec[pos + 1 : stop], stop + 1
    stop = _span_of(spec, pos, _LETTERS)
    if stop - pos < 3:
        return None
    return spec[pos:stop], stop


def _utc_offset(spec: str, pos: int) -> tuple[int | None, int]:
    """An offset ``[+-]hh[:mm[:ss]]``, as seconds east of UTC.

    POSIX counts west, so ``EST5`` is -05:00. GNU caps the hours at 24
    and the minutes and seconds at 59 (``UTC5:99`` is -05:59,
    ``UTC24:30`` -24:30).

    Args:
        spec (str): the TZ string.
        pos (int): where the offset starts.

    Returns:
        tuple[int | None, int]: the offset, or None when no hours follow
        the optional sign, and the position after what was read (a sign
        is read even then).
    """
    west = not spec.startswith("-", pos)
    if spec.startswith(tuple(_SIGNS), pos):
        pos += 1
    clock = _clock_fields(spec, pos)
    if clock is None:
        return None, pos
    (hours, minutes, seconds), pos = clock
    total = min(hours, 24) * _HOUR + min(minutes, 59) * 60 + min(seconds, 59)
    return (-total if west else total), pos


def _rule_time(
    spec: str, pos: int, rule: TransitionRule
) -> tuple[TransitionRule, int, bool]:
    """The ``/time`` after a rule's day, which is 02:00 when absent.

    The time takes a leading ``-`` and no caps (``/-1``, ``/25``,
    ``/3:99``). What GNU 9.7 does with a broken one, measured: ``/`` at
    the end of the string is midnight and refused; a ``/`` with no hours
    after it is 02:00 (``-02:00`` after ``/-``), accepted only when a
    comma or the end follows; any other character after the day is
    midnight and refused.

    Args:
        spec (str): the TZ string.
        pos (int): the position after the rule's day.
        rule (TransitionRule): the rule as read so far, at midnight.

    Returns:
        tuple[TransitionRule, int, bool]: the rule with its time, the
        position after it, and whether GNU accepted it.
    """
    if pos == len(spec) or spec[pos] == ",":
        return replace(rule, seconds=2 * _HOUR), pos, True
    if spec[pos] != "/" or pos + 1 == len(spec):
        return rule, pos, False
    pos += 1
    sign = -1 if spec[pos] == "-" else 1
    if sign < 0:
        pos += 1
    clock = _clock_fields(spec, pos)
    seconds = 2 * _HOUR
    if clock is not None:
        (hours, minutes, secs), pos = clock
        seconds = hours * _HOUR + minutes * 60 + secs
    accepted = pos == len(spec) or spec[pos] == ","
    return replace(rule, seconds=sign * seconds), pos, accepted


def _year_day_rule(
    spec: str, pos: int, kind: str, first: int
) -> tuple[TransitionRule, int, bool]:
    """The day of a ``Jn`` (1 to 365) or ``n`` (0 to 365) rule.

    The day is plain digits, no blank or sign; one out of range, or
    none, is refused as day 0.

    Args:
        spec (str): the TZ string.
        pos (int): where the digits start.
        kind (str): ``J`` or ``D``.
        first (int): the lowest day the form allows.

    Returns:
        tuple[TransitionRule, int, bool]: the rule at midnight, the
        position after the digits, and whether the day was accepted.
    """
    stop = _span_of(spec, pos, _DIGITS)
    digits = spec[pos:stop].lstrip("0")
    day = int(digits or "0") if len(digits) <= 3 else 1000
    if stop == pos or not first <= day <= 365:
        return TransitionRule(kind, day=0, seconds=0), stop, False
    return TransitionRule(kind, day=day, seconds=0), stop, True


def _weekday_rule(spec: str, pos: int) -> tuple[TransitionRule, int, bool]:
    """The ``m.w.d`` of an ``Mm.w.d`` rule.

    A refused rule keeps all three fields as written: ``M3.6.3`` is the
    last Wednesday of March, ``M3.5.9`` the last Tuesday, ``M3`` the
    first Sunday. A month outside 1 to 12 gives GNU dates that follow no
    rule we measured; mirage reads that rule as Julian day 0.

    Args:
        spec (str): the TZ string.
        pos (int): the position after ``M``.

    Returns:
        tuple[TransitionRule, int, bool]: the rule at midnight, the
        position after it, and whether all three fields were in range.
    """
    fields: list[int] = []
    while len(fields) < 3:
        if fields and not spec.startswith(".", pos):
            break
        got = _number_field(spec, pos + (1 if fields else 0))
        if got is None:
            break
        fields.append(got[0])
        pos = got[1]
    month, week, weekday = fields + [0] * (3 - len(fields))
    if not 1 <= month <= 12:
        return _DAY_BEFORE_YEAR, pos, False
    rule = TransitionRule(
        "M", month=month, week=week, weekday=weekday, seconds=0
    )
    accepted = len(fields) == 3 and 1 <= week <= 5 and weekday <= 6
    return rule, pos, accepted


def _dst_transition(spec: str, pos: int) -> tuple[TransitionRule, int, bool]:
    """One rule, ``Mm.w.d``, ``Jn`` or ``n``, with its time.

    Args:
        spec (str): the TZ string.
        pos (int): where the rule starts.

    Returns:
        tuple[TransitionRule, int, bool]: the rule, the position after
        it, and whether GNU accepted it; a refused rule keeps what was
        read of it.
    """
    lead = spec[pos : pos + 1]
    if lead == "M":
        rule, pos, accepted = _weekday_rule(spec, pos + 1)
    elif lead == "J":
        rule, pos, accepted = _year_day_rule(spec, pos + 1, "J", 1)
    elif lead and lead in _DIGITS:
        rule, pos, accepted = _year_day_rule(spec, pos, "D", 0)
    else:
        return _UNREAD_RULE, pos, False
    if not accepted:
        return rule, pos, False
    return _rule_time(spec, pos, rule)


def _dst_rules(spec: str, pos: int) -> tuple[TransitionRule, TransitionRule]:
    """The ``,start[,end]`` that follows the DST name and offset.

    With nothing there, or only a comma, both rules fall back; with only
    a start, the end does. A refused start leaves the end unread, and
    text other than a comma leaves both unread, which puts DST all year
    east of UTC (``CET-1CEST,bogus``) and nearly all year west of it.

    Args:
        spec (str): the TZ string.
        pos (int): where the rules start.

    Returns:
        tuple[TransitionRule, TransitionRule]: the start and end rules.
    """
    if pos == len(spec) or spec[pos:] == ",":
        return _FALLBACK_START, _FALLBACK_END
    if spec[pos] != ",":
        return _UNREAD_RULE, _UNREAD_RULE
    start, pos, accepted = _dst_transition(spec, pos + 1)
    if not accepted:
        return start, _UNREAD_RULE
    if pos + 1 >= len(spec):
        return start, _FALLBACK_END
    end, _, _ = _dst_transition(spec, pos + 1)
    return start, end


def _clamped(east: int) -> timedelta:
    """An offset in seconds east as a timedelta a tzinfo may return.

    Args:
        east (int): the offset GNU would use.
    """
    return timedelta(seconds=max(-_OFFSET_LIMIT, min(_OFFSET_LIMIT, east)))


def posix_zone(spec: str) -> tzinfo:
    """The zone a POSIX TZ string describes, as GNU 9.7 renders it.

    ``std offset [dst [offset] [,start[/time],end[/time]]]``: no DST name
    gives a fixed zone, and a DST offset defaults to an hour east of the
    standard one. A string GNU cannot read keeps what it read: no
    standard name is UTC with an empty name (``AB5``), no standard
    offset UTC under the name (``XYZ``, ``Bogus/Zone``), and a DST name
    it cannot read a nameless half at UTC (``EST5x``).

    Args:
        spec (str): the TZ string, without a leading colon.
    """
    std = _zone_name(spec, 0)
    if std is None:
        return timezone(timedelta(0), "")
    std_name, pos = std
    if not spec[pos : pos + 1] or spec[pos] not in _SIGNS + _DIGITS:
        return timezone(timedelta(0), std_name)
    std_east, pos = _utc_offset(spec, pos)
    if std_east is None:
        return timezone(timedelta(0), std_name)
    if pos == len(spec):
        return timezone(_clamped(std_east), std_name)
    dst = _zone_name(spec, pos)
    dst_name, dst_east = "", 0
    if dst is not None:
        dst_name, pos = dst
        offset, pos = _utc_offset(spec, pos)
        dst_east = std_east + _HOUR if offset is None else offset
    start, end = _dst_rules(spec, pos)
    return PosixZone(
        std_name,
        _clamped(std_east),
        dst_name,
        _clamped(dst_east),
        start,
        end,
    )


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
    return (
        0 if offset is None else int(offset.total_seconds()),
        local.tzname() or "",
    )


def _first_shown(
    zone: ZoneInfo, before: datetime, after: datetime, reading: tuple[int, str]
) -> datetime:
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


def zone_abbreviations(
    name: str, step: timedelta = _DAY
) -> list[tuple[int, str, int]]:
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
            since = (
                at
                if at == previous
                else _first_shown(zone, previous, at, reading)
            )
            rows.append((offset, abbrev, int(since.timestamp())))
            current[offset] = abbrev
        previous = at
        at += step
    lettered = {
        offset
        for offset, abbrev, _ in rows
        if abbrev != numeric_abbreviation(offset)
    }
    return [row for row in rows if row[0] in lettered]
