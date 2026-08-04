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

from mirage.commands.builtin.utils.constants import (DEFAULT_MODES,
                                                     EPOCH_LS_TIME, MONTHS,
                                                     NUMERIC_PREFIX,
                                                     TYPE_CHARS)
from mirage.types import LINK_TARGET_KEY, FileStat, FileType


def _human_size(n: int) -> str:
    units = ("B", "K", "M", "G", "T")
    value = float(n)
    i = 0
    while value >= 1024 and i < len(units) - 1:
        value /= 1024
        i += 1
    text = str(round(value)) if i == 0 else f"{value:.1f}"
    return f"{text}{units[i]}"


def _perm_triplet(bits: int, special: str | None = None) -> str:
    if special is not None:
        execbit = special.lower() if bits & 1 else special.upper()
    else:
        execbit = "x" if bits & 1 else "-"
    return ("r" if bits & 4 else "-") + ("w" if bits & 2 else "-") + execbit


def _ls_mode_string(s: FileStat) -> str:
    type_char = TYPE_CHARS.get(s.type, "-") if s.type is not None else "-"
    default = DEFAULT_MODES.get(s.type, 0o644) if s.type is not None else 0o644
    mode = s.mode if s.mode is not None else default
    perms = (_perm_triplet(mode >> 6, "s" if mode & 0o4000 else None) +
             _perm_triplet(mode >> 3, "s" if mode & 0o2000 else None) +
             _perm_triplet(mode, "t" if mode & 0o1000 else None))
    return f"{type_char}{perms}"


def _ls_time_string(modified: str | None) -> str:
    if not modified:
        return EPOCH_LS_TIME
    try:
        text = modified.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return EPOCH_LS_TIME
    month = MONTHS[dt.month - 1]
    day = f"{dt.day:>2}"
    return f"{month} {day} {dt.hour:02d}:{dt.minute:02d}"


def _ls_name(s: FileStat) -> str:
    """The name column: GNU appends ``-> target`` for a symlink row.

    Args:
        s (FileStat): the row being rendered.
    """
    if s.type != FileType.SYMLINK:
        return s.name
    target = s.extra.get(LINK_TARGET_KEY)
    return f"{s.name} -> {target}" if target else s.name


def format_ls_long(
    stats: list[FileStat],
    *,
    human: bool = False,
    owner: str = "user",
    group: str = "user",
    size_width: int | None = None,
) -> list[str]:
    sizes = [
        _human_size(s.size or 0) if human else str(s.size or 0) for s in stats
    ]
    width = size_width if size_width is not None else max(
        (len(x) for x in sizes), default=1)
    out: list[str] = []
    for s, raw_size in zip(stats, sizes):
        if s.size is None and s.modified is None:
            mode = _ls_mode_string(s)
            out.append(f"{mode}\t-\t-\t{_ls_name(s)}")
            continue
        mode = _ls_mode_string(s)
        size = raw_size.rjust(width)
        time = _ls_time_string(s.modified)
        who = str(s.uid) if s.uid is not None else owner
        grp = str(s.gid) if s.gid is not None else group
        out.append(f"{mode} 1 {who} {grp} {size} {time} {_ls_name(s)}")
    return out


def to_number(val: str) -> float:
    """Coerce a string to a number with GNU awk semantics.

    Args:
        val (str): raw token; the leading numeric prefix counts, else 0.
    """
    m = NUMERIC_PREFIX.match(val.strip())
    return float(m.group(0)) if m else 0.0


def format_number(val: float) -> str:
    """Render an awk numeric value, collapsing integral floats.

    Args:
        val (float): numeric value to render.
    """
    return str(int(val)) if val == int(val) else str(val)
