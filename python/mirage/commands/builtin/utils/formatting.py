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
from datetime import datetime, timezone

from mirage.commands.builtin.utils import constants
from mirage.commands.builtin.utils.identity import (UNKNOWN_NAME, Identity,
                                                    group_name, owner_name)
from mirage.types import (DEVICE_NUMBERS_KEY, LINK_TARGET_KEY, FileStat,
                          FileType)

# What a stat field a VFS cannot know renders as, in `stat -c` and in
# the inode and block columns of `find -ls`.
UNKNOWN_STAT_FIELD = "?"


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


def _ls_time_string(modified: str | None, *, find_rule: bool = False) -> str:
    """The time column: ``Mon DD HH:MM`` for a recent time, ``Mon DD  YYYY``
    for an old or future one, as GNU prints it.

    Args:
        modified (str | None): the ISO timestamp, None when unknown.
        find_rule (bool): use findutils' window (old past 180 days,
            future past an hour) rather than ls's (the last half year,
            never the future).
    """
    if not modified:
        return constants.EPOCH_LS_TIME
    try:
        text = modified.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return constants.EPOCH_LS_TIME
    month = constants.MONTHS[dt.month - 1]
    day = f"{dt.day:>2}"
    now = time.time()
    when = dt.timestamp()
    if find_rule:
        recent = not (now > when + constants.FIND_OLD_SECONDS
                      or when > now + constants.FIND_FUTURE_SECONDS)
    else:
        recent = now - constants.LS_RECENT_SECONDS < when < now
    if recent:
        return f"{month} {day} {dt.hour:02d}:{dt.minute:02d}"
    return f"{month} {day}  {dt.year}"


def _ls_name(s: FileStat) -> str:
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
                      find_rule: bool = False) -> tuple[str, str]:
    """The size and time columns of one ``ls -l`` row.

    A device row carries its major and minor numbers where GNU puts
    them. An entry with neither a size nor a time (a synthetic
    API-backend directory) shows ``-`` in both rather than inventing
    size 0 and the epoch.

    Args:
        s (FileStat): the row's stat.
        human (bool): render the size with ``-h`` units.
        find_rule (bool): findutils' recent-time window, for ``-ls``.
    """
    dev = s.extra.get(DEVICE_NUMBERS_KEY) if s.extra else None
    if dev:
        when = (UNKNOWN_NAME if s.modified is None else _ls_time_string(
            s.modified, find_rule=find_rule))
        return f"{dev[0]}, {dev[1]}", when
    if s.size is None and s.modified is None:
        return UNKNOWN_NAME, UNKNOWN_NAME
    size = human_size(s.size or 0) if human else str(s.size or 0)
    return size, _ls_time_string(s.modified, find_rule=find_rule)


def format_ls_long(
    stats: list[FileStat],
    *,
    human: bool = False,
    identity: Identity | None = None,
    size_width: int | None = None,
) -> list[str]:
    """Render ``ls -l`` rows: mode, links, owner, group, size, time, name.

    The owner is the entry's uid when a backend or the attr overlay
    reports one, else the workspace user; the group is the gid, else the
    session's profile; ``-`` when nothing names one.

    Args:
        stats (list[FileStat]): the rows to render.
        human (bool): render sizes with ``-h`` units.
        identity (Identity | None): who the session is; None outside a
            workspace, where both columns fall back to ``-``.
        size_width (int | None): the size column's width, computed from
            the rows when None.
    """
    columns = [_ls_size_and_time(s, human) for s in stats]
    width = size_width if size_width is not None else max(
        (len(size) for size, _ in columns), default=1)
    out: list[str] = []
    for s, (raw_size, when) in zip(stats, columns):
        mode = ls_mode_string(s)
        size = raw_size.rjust(width)
        who = owner_name(s.uid, identity)
        grp = group_name(s.gid, identity)
        out.append(f"{mode} 1 {who} {grp} {size} {when} {_ls_name(s)}")
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
