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
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from mirage.commands.builtin.constants import UINTMAX
from mirage.commands.builtin.utils import constants
from mirage.commands.builtin.utils.identity import (UNKNOWN_NAME, Identity,
                                                    group_name, owner_name)
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.types import (DEVICE_NUMBERS_KEY, LINK_TARGET_KEY, FileStat,
                          FileType, LsTimeKind)
from mirage.utils.stat_view import content_size, is_dir

# GNU's --block-size units: the letter, its 1024-based factor and the two
# suffixes it prints (K for KiB, kB for KB). xstrtoumax's table, which
# takes every letter in upper case and only k, m, g and t in lower case;
# R and Q are not in it (coreutils 9.7 refuses `--block-size=1R`).
BLOCK_UNITS = "KMGTPEZY"
_LOWER_BLOCK_UNITS = "kmgt"
_C_SPACE = " \t\n\v\f\r"
LS_TIME_STYLES = ("full-iso", "long-iso", "iso", "locale")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class BlockSize:
    """How ``--block-size`` scales the size column.

    Args:
        divisor (int): bytes per printed unit; sizes round up.
        suffix (str): what GNU prints after the count (``K``, ``kB``,
            nothing for a bare number).
        human_base (int | None): 1024 for ``human-readable``, 1000 for
            ``si``, None for a fixed divisor.
    """
    divisor: int = 1
    suffix: str = ""
    human_base: int | None = None


@dataclass(frozen=True, slots=True)
class LsColumns:
    """Which columns an ``ls`` row carries and how its time is spelled.

    Args:
        owner (bool): the owner column; ``-g`` drops it.
        group (bool): the group column; ``-o`` drops it.
        inode (bool): ``-i``; a VFS has no inode, so the column is ``?``,
            the answer ``stat %i`` already gives.
        context (bool): ``-Z``; no security context here either, so ``?``
            as GNU prints it on a filesystem without one.
        time_kind (LsTimeKind): which timestamp the time column shows.
        time_style (str): ``locale`` (GNU's default six-month rule),
            ``full-iso``, ``long-iso``, ``iso``, or ``+FORMAT``.
        block_size (BlockSize | None): ``--block-size``, None for bytes.
    """
    owner: bool = True
    group: bool = True
    inode: bool = False
    context: bool = False
    time_kind: LsTimeKind = LsTimeKind.MTIME
    time_style: str = "locale"
    block_size: BlockSize | None = None


DEFAULT_COLUMNS = LsColumns()


class BlockSizeRefusal(Enum):
    """Which of GNU's three ``--block-size`` refusals a value earned.

    xstrtoumax's three failures, which ls words differently: a word it
    cannot read a number or a unit out of (``x``, ``0``, ``iB``, an
    empty value), a number followed by something that is not a unit
    (``1x``, ``1.5K``, ``Kx``, a trailing blank), and a value past
    UINTMAX_MAX (``Y`` alone is 2**80). The suffix test outranks the
    overflow test, as gnulib's ``LONGINT_INVALID_SUFFIX_CHAR_WITH_OVERFLOW``
    is worded as the suffix failure.
    """

    INVALID = "invalid"
    INVALID_SUFFIX = "invalid suffix"
    TOO_LARGE = "too large"


def _block_unit_power(letter: str) -> int | None:
    """The 1024-power a unit letter stands for, or None for a non-unit.

    Args:
        letter (str): one character of the value.
    """
    if letter in BLOCK_UNITS or letter in _LOWER_BLOCK_UNITS:
        return BLOCK_UNITS.index(letter.upper()) + 1
    return None


def parse_block_size(text: str) -> BlockSize | BlockSizeRefusal:
    """GNU's ``--block-size=SIZE`` grammar, or which refusal it earns.

    ``human-readable`` and ``si`` pick the two ``-h`` scales; otherwise
    an optional count is followed by an optional unit letter, ``B``
    making it decimal (``KB`` is 1000 and prints ``kB``) and ``iB``
    keeping it binary. The count is read the way strtoumax reads it:
    leading blanks and one ``+`` are skipped, a ``-`` is not a sign
    here. A zero count is refused under any unit, as GNU refuses ``0K``
    the way it refuses ``0``, and a product past UINTMAX_MAX is too
    large. Measured on coreutils 9.7: ``ls --block-size=`` with ``x``,
    ``0K``, ``iB``, ``B``, ``-1K`` and ``''`` is invalid; with ``1x``,
    ``1e``, ``Kx``, ``1Ki``, ``1.5K``, ``1R`` and ``'1 '`` is an invalid
    suffix; with ``Y``, ``16E`` and ``18446744073709551616`` is too
    large. Deliberate divergence: strtoumax reads a ``0x`` or ``0``
    prefix as hexadecimal or octal (``010`` is 8 blocks), mirage reads
    every count in decimal.

    Args:
        text (str): the option value as typed.
    """
    if text == "human-readable":
        return BlockSize(1024, "", 1024)
    if text == "si":
        return BlockSize(1000, "", 1000)
    # strtol's prefix: leading C blanks and one `+` are skipped only in
    # front of a digit (`' +1'` is 1) and never in front of a bare unit
    # (`+K` and `' K'` are refused, coreutils 9.7).
    body = text.lstrip(_C_SPACE).removeprefix("+")
    if body != text and not body[:1].isdigit():
        return BlockSizeRefusal.INVALID
    i = 0
    while i < len(body) and body[i] in "0123456789":
        i += 1
    digits, unit = body[:i], body[i:]
    if not digits and (not unit or _block_unit_power(unit[0]) is None):
        return BlockSizeRefusal.INVALID
    count = int(digits) if digits else 1
    factor = 1
    shown = ""
    if unit:
        letter, rest = unit[0], unit[1:]
        power = _block_unit_power(letter)
        if power is None:
            return BlockSizeRefusal.INVALID_SUFFIX
        upper = letter.upper()
        if rest == "":
            factor, shown = 1024**power, upper
        elif rest == "B":
            factor, shown = 1000**power, ("k" if upper == "K" else upper) + "B"
        elif rest == "iB":
            factor, shown = 1024**power, upper + "iB"
        else:
            return BlockSizeRefusal.INVALID_SUFFIX
    if count * factor > UINTMAX:
        return BlockSizeRefusal.TOO_LARGE
    if count == 0:
        return BlockSizeRefusal.INVALID
    # The unit is echoed after each size only when the value was a bare
    # unit: `K` prints `4K`, `KiB` prints `4KiB`, `1K` and `2K` print
    # `4` and `2` (coreutils 9.7).
    return BlockSize(count * factor, shown if not digits else "")


def scaled_size(n: int, block: BlockSize | None, human: bool) -> str:
    """The size column under ``-h`` or ``--block-size``, bytes otherwise.

    Args:
        n (int): the byte count.
        block (BlockSize | None): the ``--block-size`` scale, if any.
        human (bool): ``-h``, when no block size overrides it.
    """
    if block is None:
        return human_size(n) if human else str(n)
    if block.human_base == 1000:
        return human_scaled(n, 1000, ("", "k", "M", "G", "T", "P", "E"))
    if block.human_base is not None:
        return human_size(n)
    return f"{-(-n // block.divisor)}{block.suffix}"


# What a stat field a VFS cannot know renders as, in `stat -c` and in
# the inode and block columns of `find -ls`.
UNKNOWN_STAT_FIELD = "?"

# FileStat.extra key marking an `ls` row whose stat failed: the listing
# named the entry, so GNU keeps its row, and every fact only a stat
# supplies prints as UNKNOWN_STAT_FIELD. Its type is a directory's when
# the listing slash-marked it, and unknown otherwise.
STAT_FAILED_KEY = "stat_failed"


def human_scaled(n: int, base: int, units: tuple[str, ...]) -> str:
    """GNU's ``human_readable`` rounding, shared by ``-h`` and ``-H``.

    Three rules, none of which fall out of a plain divide-and-format.
    Below one unit GNU prints the count alone -- ``24``, never ``24B``.
    Above it the value is rounded *up* to the precision shown, so 1025
    bytes is ``1.1K`` rather than ``1.0K``. And the decimal is dropped
    once the scaled value reaches ten, giving ``10K`` rather than
    ``10.0K``. Rounding up can carry past the base (1048575 bytes ceils
    to 1024K, which GNU shows as ``1.0M``), so the unit is re-chosen
    after rounding instead of once up front.

    Args:
        n (int): byte count.
        base (int): 1024 for ``-h``, 1000 for ``-H``.
        units (tuple[str, ...]): suffixes indexed by power; index 0 is
            unused because a sub-unit count carries no suffix at all.

    Returns:
        str: the size as GNU would print it.
    """
    if n < base:
        return str(n)
    i, divisor = 1, base
    while True:
        tenths = -(-n * 10 // divisor)
        if tenths < 100:
            return f"{tenths // 10}.{tenths % 10}{units[i]}"
        whole = -(-n // divisor)
        if whole < base or i == len(units) - 1:
            return f"{whole}{units[i]}"
        i += 1
        divisor *= base


def human_size(n: int) -> str:
    return human_scaled(n, 1024, ("", "K", "M", "G", "T", "P", "E"))


def _perm_triplet(bits: int, special: str | None = None) -> str:
    if special is not None:
        execbit = special.lower() if bits & 1 else special.upper()
    else:
        execbit = "x" if bits & 1 else "-"
    return ("r" if bits & 4 else "-") + ("w" if bits & 2 else "-") + execbit


def ls_mode_string(s: FileStat) -> str:
    type_char = constants.TYPE_CHARS.get(s.type, "-")
    mode = s.mode if s.mode is not None else constants.DEFAULT_MODES.get(
        s.type, 0o644)
    perms = (_perm_triplet(mode >> 6, "s" if mode & 0o4000 else None) +
             _perm_triplet(mode >> 3, "s" if mode & 0o2000 else None) +
             _perm_triplet(mode, "t" if mode & 0o1000 else None))
    return f"{type_char}{perms}"


def _parse_when(modified: str | None) -> datetime | None:
    """A stat timestamp as an aware UTC datetime, None when unreadable.

    Args:
        modified (str | None): the ISO timestamp, None when unknown.
    """
    if not modified:
        return None
    try:
        text = modified.replace("Z", "+00:00")
        return datetime.fromisoformat(text).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _is_recent(when: float, *, find_rule: bool) -> bool:
    """GNU's "recent" test: within the last half year and not in the
    future for ls, findutils' wider window for ``find -ls``.

    Args:
        when (float): the timestamp as epoch seconds.
        find_rule (bool): findutils' window (old past 180 days, future
            past an hour) rather than ls's.
    """
    now = time.time()
    if find_rule:
        return not (now > when + constants.FIND_OLD_SECONDS
                    or when > now + constants.FIND_FUTURE_SECONDS)
    return now - constants.LS_RECENT_SECONDS < when < now


def _ls_time_string(modified: str | None, *, find_rule: bool = False) -> str:
    """The time column: ``Mon DD HH:MM`` for a recent time, ``Mon DD  YYYY``
    for an old or future one, as GNU prints it.

    Args:
        modified (str | None): the ISO timestamp, None when unknown.
        find_rule (bool): use findutils' window (old past 180 days,
            future past an hour) rather than ls's (the last half year,
            never the future).
    """
    dt = _parse_when(modified)
    if dt is None:
        return constants.EPOCH_LS_TIME
    month = constants.MONTHS[dt.month - 1]
    day = f"{dt.day:>2}"
    if _is_recent(dt.timestamp(), find_rule=find_rule):
        return f"{month} {day} {dt.hour:02d}:{dt.minute:02d}"
    return f"{month} {day}  {dt.year}"


def styled_time(modified: str | None, style: str) -> str:
    """The time column under ``--time-style``.

    ``full-iso``, ``long-iso`` and ``iso`` are GNU's three ISO shapes
    (``iso`` pads its year form to the width of its recent form, which
    is where its trailing space comes from); ``+FORMAT`` is a ``date``
    format, and one holding a newline names two, the first for a time
    outside the recent window and the second for one inside it. An
    unknown time renders the epoch, as the default style does.

    Args:
        modified (str | None): the ISO timestamp, None when unknown.
        style (str): the style, ``posix-`` prefix already stripped.
    """
    if style == "locale":
        return _ls_time_string(modified)
    dt = _parse_when(modified) or _EPOCH
    if style == "full-iso":
        return gnu_strftime(dt, "%Y-%m-%d %H:%M:%S.%N %z")
    if style == "long-iso":
        return gnu_strftime(dt, "%Y-%m-%d %H:%M")
    recent = _is_recent(dt.timestamp(), find_rule=False)
    if style == "iso":
        return gnu_strftime(dt, "%m-%d %H:%M" if recent else "%Y-%m-%d ")
    fmt = style[1:]
    old_fmt, sep, recent_fmt = fmt.partition("\n")
    return gnu_strftime(dt, recent_fmt if sep and recent else old_fmt)


def time_of(s: FileStat, kind: LsTimeKind) -> str | None:
    """The timestamp an ``ls`` column shows for one row.

    A backend reports one clock, so the access time falls back to the
    modification time and the status-change time is the modification
    time (a plain write moves both together on POSIX); a birth time is
    something no backend here reports, so it stays unknown.

    Args:
        s (FileStat): the row.
        kind (LsTimeKind): which timestamp was asked for.
    """
    if kind is LsTimeKind.ATIME:
        return s.atime or s.modified
    if kind is LsTimeKind.BIRTH:
        return None
    return s.modified


def ls_name(s: FileStat) -> str:
    """The name column: GNU appends ``-> target`` for a symlink row.

    Args:
        s (FileStat): the row being rendered.
    """
    if s.type != FileType.SYMLINK:
        return s.name
    target = s.extra.get(LINK_TARGET_KEY)
    return f"{s.name} -> {target}" if target else s.name


def _ls_size_and_time(s: FileStat,
                      human: bool,
                      *,
                      find_rule: bool = False,
                      columns: LsColumns = DEFAULT_COLUMNS) -> tuple[str, str]:
    """The size and time columns of one ``ls -l`` row.

    A device row carries its major and minor numbers where GNU puts
    them. An entry with neither a size nor a time (a synthetic
    API-backend directory) shows ``-`` for the time rather than
    inventing the epoch, and so does a time kind no backend reports;
    its size is ``-`` too unless it is a directory, whose size is
    always ``DIR_SIZE``.

    Args:
        s (FileStat): the row's stat.
        human (bool): render the size with ``-h`` units.
        find_rule (bool): findutils' recent-time window, for ``-ls``.
        columns (LsColumns): which time to show, how to spell it, and
            the ``--block-size`` scale.
    """
    when_iso = time_of(s, columns.time_kind)
    known_time = columns.time_kind is not LsTimeKind.BIRTH
    dev = s.extra.get(DEVICE_NUMBERS_KEY) if s.extra else None
    if dev:
        when = (UNKNOWN_NAME if not known_time or when_iso is None else
                _ls_time_string(when_iso, find_rule=find_rule)
                if find_rule else styled_time(when_iso, columns.time_style))
        return f"{dev[0]}, {dev[1]}", when
    size = (UNKNOWN_NAME if not is_dir(s) and s.size is None else scaled_size(
        content_size(s), columns.block_size, human))
    if not known_time or when_iso is None:
        return size, UNKNOWN_NAME
    if find_rule:
        return size, _ls_time_string(when_iso, find_rule=True)
    return size, styled_time(when_iso, columns.time_style)


def ls_prefix(columns: LsColumns) -> str:
    """What ``-i`` and ``-Z`` put in front of a short row: ``?`` for
    each, since a VFS has neither an inode nor a security context.

    Args:
        columns (LsColumns): the requested columns.
    """
    parts = []
    if columns.inode:
        parts.append(UNKNOWN_STAT_FIELD)
    if columns.context:
        parts.append(UNKNOWN_STAT_FIELD)
    return "".join(f"{p} " for p in parts)


def format_ls_long(
    stats: list[FileStat],
    *,
    human: bool = False,
    identity: Identity | None = None,
    size_width: int | None = None,
    columns: LsColumns = DEFAULT_COLUMNS,
    names: list[str] | None = None,
) -> list[str]:
    """Render ``ls -l`` rows: mode, links, owner, group, size, time, name.

    The owner is the entry's uid when a backend or the attr overlay
    reports one, else the workspace user; the group is the gid, else the
    session's profile; ``-`` when nothing names one. ``-g`` and ``-o``
    drop a column, ``-i`` leads with the inode column and ``-Z`` puts the
    context column before the size, both ``?`` as GNU prints them when
    the filesystem has neither. A row whose stat failed is GNU's: the
    type letter the listing gave, then ``?`` for every stat field, the
    time right-aligned in its column.

    Args:
        stats (list[FileStat]): the rows to render.
        human (bool): render sizes with ``-h`` units.
        identity (Identity | None): who the session is; None outside a
            workspace, where both columns fall back to ``-``.
        size_width (int | None): the size column's width, computed from
            the rows when None.
        columns (LsColumns): which columns to carry and how to spell the
            time.
        names (list[str] | None): the name column per row when the
            caller decorated it (``--hyperlink``), else the row's own.
    """
    cells = [(UNKNOWN_STAT_FIELD,
              UNKNOWN_STAT_FIELD) if s.extra.get(STAT_FAILED_KEY) else
             _ls_size_and_time(s, human, columns=columns) for s in stats]
    width = size_width if size_width is not None else max(
        (len(size) for size, _ in cells), default=1)
    time_width = max((len(when) for _, when in cells), default=1)
    out: list[str] = []
    for i, (s, (raw_size, when)) in enumerate(zip(stats, cells)):
        failed = bool(s.extra.get(STAT_FAILED_KEY))
        if failed:
            type_char = ("d" if s.type == FileType.DIRECTORY else
                         UNKNOWN_STAT_FIELD)
            fields = [type_char + UNKNOWN_STAT_FIELD * 9, UNKNOWN_STAT_FIELD]
        else:
            fields = [ls_mode_string(s), "1"]
        if columns.owner:
            fields.append(
                UNKNOWN_STAT_FIELD if failed else owner_name(s.uid, identity))
        if columns.group:
            fields.append(
                UNKNOWN_STAT_FIELD if failed else group_name(s.gid, identity))
        if columns.context:
            fields.append(UNKNOWN_STAT_FIELD)
        fields.append(raw_size.rjust(width))
        fields.append(when.rjust(time_width) if failed else when)
        fields.append(names[i] if names is not None else ls_name(s))
        lead = f"{UNKNOWN_STAT_FIELD} " if columns.inode else ""
        out.append(lead + " ".join(fields))
    return out


def escape_find_name(text: str) -> str:
    """Spell a name the way ``find -ls`` prints it.

    findutils escapes a name so one row stays one line and its fields
    stay in place: a backslash, a space and a double quote take a
    backslash, the C escapes stand for their control characters, and
    every other control character and every byte outside ASCII is an
    octal escape (``\\303\\274`` for ``ü``, as GNU prints it in the C
    locale). ``-print`` is untouched; only the listing is a table.

    Args:
        text (str): the name or link target as it is.
    """
    out: list[str] = []
    for ch in text:
        escaped = constants.FIND_LS_ESCAPES.get(ch)
        if escaped is not None:
            out.append(escaped)
        elif " " < ch < "\x7f":
            out.append(ch)
        else:
            out.append("".join(f"\\{byte:03o}" for byte in ch.encode()))
    return "".join(out)


def _find_ls_name(s: FileStat) -> str:
    """The name column of a ``find -ls`` row, escaped, with the link
    target escaped the same way.

    Args:
        s (FileStat): the row, named as find printed it.
    """
    name = escape_find_name(s.name)
    if s.type != FileType.SYMLINK:
        return name
    target = s.extra.get(LINK_TARGET_KEY)
    return f"{name} -> {escape_find_name(target)}" if target else name


def format_find_ls(s: FileStat, identity: Identity | None) -> str:
    """Render one ``find -ls`` row in findutils' own layout.

    GNU's ``list_file`` is not ``ls -l``: it leads with the inode and
    the allocated 1K blocks, then fixes every column's width (inode 9,
    blocks 6, links 3, owner and group 8 left-aligned, size 8) instead
    of fitting them to the listing, so a consumer can count fields.
    The inode and block columns carry ``?``, the answer ``stat %i``
    and ``%b`` already give: a VFS has no inode and no block
    allocation, and a number invented for either would read as a fact.
    The remaining columns are the ``ls -l`` ones, from the same
    helpers, so the two listings cannot disagree about a row; only the
    name is spelled differently, escaped (``escape_find_name``) so the
    row stays one line of fixed fields.

    Args:
        s (FileStat): the row, named as find printed it.
        identity (Identity | None): who the session is; None outside a
            workspace, where both name columns fall back to ``-``.
    """
    size, when = _ls_size_and_time(s, False, find_rule=True)
    who = owner_name(s.uid, identity)
    grp = group_name(s.gid, identity)
    return (f"{UNKNOWN_STAT_FIELD:>9} {UNKNOWN_STAT_FIELD:>6} "
            f"{ls_mode_string(s)} {1:>3} {who:<8} {grp:<8} {size:>8} {when} "
            f"{_find_ls_name(s)}")


def to_number(val: str) -> float:
    """Coerce a string to a number with GNU awk semantics.

    Args:
        val (str): raw token; the leading numeric prefix counts, else 0.
    """
    m = constants.NUMERIC_PREFIX.match(val.strip())
    return float(m.group(0)) if m else 0.0


def format_number(val: float) -> str:
    """Render an awk numeric value, collapsing integral floats.

    Args:
        val (float): numeric value to render.
    """
    return str(int(val)) if val == int(val) else str(val)
