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

from datetime import datetime, timezone
from stat import filemode

from mirage.commands.builtin.types import (
    PrintfDirective,
    PrintfLiteral,
    PrintfPart,
    PrintfTime,
)
from mirage.commands.builtin.utils.identity import (
    Identity,
    group_name,
    owner_name,
)
from mirage.core.generic.find_eval import printf_kind
from mirage.types import FileStat, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.stat_view import (
    ALL_MODE_BITS,
    CHAR_MODE,
    DIR_MODE,
    FIFO_MODE,
    FILE_MODE,
    LINK_MODE,
    content_size,
)

# One mode per kind, spelled from the same constants every stat
# translator uses (utils/stat_view.py); links are 777 the way ls draws
# them.
_KIND_MODE = {
    "c": CHAR_MODE,
    "d": DIR_MODE,
    "l": LINK_MODE,
    "p": FIFO_MODE,
    "f": FILE_MODE,
}


def _relative_part(row: str, search: PathSpec) -> str:
    base = search.raw_path or search.virtual
    if row == base:
        return ""
    stem = base if base.endswith("/") else base + "/"
    if row.startswith(stem):
        return row[len(stem) :]
    return row


def _mtime_epoch(st: FileStat | None) -> float:
    if st is None or st.modified is None:
        return 0.0
    return iso_timestamp(st.modified) or 0.0


_DAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def _time_fields(ts: float) -> dict[str, str]:
    """Every ``%T<letter>`` GNU find renders, for one UTC timestamp.

    Spelled out rather than handed to ``strftime``, whose letters and
    their meaning (``%s`` in local time, ``%P``) differ by platform.
    ``%TS``, ``%TT`` and ``%TX`` carry the fraction GNU appends.

    Args:
        ts (float): seconds since the epoch.
    """
    whole, micros = divmod(round(ts * 1_000_000), 1_000_000)
    dt = datetime.fromtimestamp(whole, timezone.utc)
    frac = f"{micros:06d}0000"
    iso_year, iso_week, iso_day = dt.isocalendar()
    yday = dt.timetuple().tm_yday - 1
    wday = iso_day % 7
    hour12 = dt.hour % 12 or 12
    day = _DAY_NAMES[dt.weekday()]
    month = _MONTH_NAMES[dt.month - 1]
    clock = f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
    date = f"{dt.month:02d}/{dt.day:02d}/{dt.year % 100:02d}"
    return {
        "@": f"{whole}.{frac}",
        "+": f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}+{clock}.{frac}",
        "a": day[:3],
        "A": day,
        "b": month[:3],
        "B": month,
        "c": f"{day[:3]} {month[:3]} {dt.day:2d} {clock} {dt.year}",
        "C": f"{dt.year // 100:02d}",
        "d": f"{dt.day:02d}",
        "D": date,
        "e": f"{dt.day:2d}",
        "F": f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}",
        "g": f"{iso_year % 100:02d}",
        "G": f"{iso_year}",
        "h": month[:3],
        "H": f"{dt.hour:02d}",
        "I": f"{hour12:02d}",
        "j": f"{yday + 1:03d}",
        "k": f"{dt.hour:2d}",
        "l": f"{hour12:2d}",
        "m": f"{dt.month:02d}",
        "M": f"{dt.minute:02d}",
        "n": "\n",
        "p": "AM" if dt.hour < 12 else "PM",
        "P": "am" if dt.hour < 12 else "pm",
        "r": f"{hour12:02d}:{dt.minute:02d}:{dt.second:02d} "
        + ("AM" if dt.hour < 12 else "PM"),
        "R": f"{dt.hour:02d}:{dt.minute:02d}",
        "s": f"{whole}",
        "S": f"{dt.second:02d}.{frac}",
        "t": "\t",
        "T": f"{clock}.{frac}",
        "u": f"{iso_day}",
        "U": f"{(yday + 7 - wday) // 7:02d}",
        "V": f"{iso_week:02d}",
        "w": f"{wday}",
        "W": f"{(yday + 7 - (iso_day - 1)) // 7:02d}",
        "x": date,
        "X": f"{clock}.{frac}",
        "y": f"{dt.year % 100:02d}",
        "Y": f"{dt.year}",
        "z": "+0000",
        "Z": "UTC",
    }


def _mode_bits(st: FileStat | None, kind: str) -> int:
    # The kind fixes the type bits; a reported mode (chmod overlay, a
    # backend that knows) supplies the permission bits, else the
    # per-kind default every stat translator uses.
    base = _KIND_MODE[kind]
    if st is None or st.mode is None:
        return base
    return (base & ~ALL_MODE_BITS) | (st.mode & ALL_MODE_BITS)


def expand_printf(
    parts: tuple[PrintfPart, ...],
    row: str,
    search: PathSpec,
    st: FileStat | None,
    target: FileStat | None = None,
    identity: Identity | None = None,
) -> str:
    """Render one compiled -printf format against one result row.

    Directives cover what GNU's find agents actually use: the path family
    (%p %P %f %h %d), the stat family (%s %y %Y %m %M), the owner family
    (%u %U %g %G, which read the entry's uid and gid and fall back to
    the workspace user and the session's profile, the same rule
    ``ls -l`` draws its columns by), %T times, and the backslash
    escapes, which mirage-rs expanded when it compiled the format. Times
    render in UTC (mirage timestamps are zone-carrying ISO strings; GNU
    renders the local zone). ``%Y`` on a symlink row reports the target's
    kind, ``N`` when the link dangles; on any other row it is ``%y``.

    Args:
        parts (tuple[PrintfPart, ...]): the format as literal runs and
            directives.
        row (str): the display row (operand-respelled).
        search (PathSpec): the start point the row came from.
        st (FileStat | None): the row's stat, when the format needs one.
        target (FileStat | None): a symlink row's resolved target stat,
            None when the link dangles; ignored for non-link rows.
        identity (Identity | None): who the session is, for the owner
            family on an entry that reports no owner of its own.
    """
    out: list[str] = []
    kind = printf_kind(st)
    for part in parts:
        if isinstance(part, PrintfLiteral):
            out.append(part.text)
        elif isinstance(part, PrintfTime):
            out.append(_time_fields(_mtime_epoch(st))[part.letter])
        else:
            out.append(
                _directive(part, row, search, st, target, identity, kind)
            )
    return "".join(out)


def _directive(
    part: PrintfDirective,
    row: str,
    search: PathSpec,
    st: FileStat | None,
    target: FileStat | None,
    identity: Identity | None,
    kind: str,
) -> str:
    code = part.code
    if code == "p":
        return row
    if code == "P":
        return _relative_part(row, search)
    if code == "f":
        trimmed = row.rstrip("/")
        return trimmed.rsplit("/", 1)[-1] if trimmed else "/"
    if code == "h":
        trimmed = row.rstrip("/")
        if "/" not in trimmed:
            return "." if trimmed else "/"
        head = trimmed.rsplit("/", 1)[0]
        return head if head else "/"
    if code == "d":
        rel = _relative_part(row, search)
        return "0" if not rel else str(rel.count("/") + 1)
    if code == "s":
        return str(content_size(st) if st is not None else 0)
    if code == "y":
        return "U" if st is None else kind
    if code == "Y":
        if st is None:
            return "U"
        if kind == "l":
            return "N" if target is None else printf_kind(target)
        return kind
    if code in ("u", "U"):
        return owner_name(st.uid if st is not None else None, identity)
    if code in ("g", "G"):
        return group_name(st.gid if st is not None else None, identity)
    if code == "m":
        return format(_mode_bits(st, kind) & ALL_MODE_BITS, "o")
    return filemode(_mode_bits(st, kind))
