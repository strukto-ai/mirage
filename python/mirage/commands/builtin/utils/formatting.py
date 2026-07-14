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
from datetime import datetime, timezone

from mirage.types import FileStat, FileType

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
           "Oct", "Nov", "Dec")

EPOCH_LS_TIME = "Jan  1 00:00"

_SIZE_UNITS = {
    "B": 1,
    "K": 1024,
    "M": 1024**2,
    "G": 1024**3,
    "T": 1024**4,
}


def _human_size(n: int) -> str:
    units = ("B", "K", "M", "G", "T")
    value = float(n)
    i = 0
    while value >= 1024 and i < len(units) - 1:
        value /= 1024
        i += 1
    text = str(round(value)) if i == 0 else f"{value:.1f}"
    return f"{text}{units[i]}"


def _perm_triplet(bits: int) -> str:
    return (("r" if bits & 4 else "-") + ("w" if bits & 2 else "-") +
            ("x" if bits & 1 else "-"))


def parse_size(text: str) -> int:
    """Invert ``_human_size``: ``4.0K`` -> 4096, plain digits pass through.

    Args:
        text (str): size text, optionally suffixed with B/K/M/G/T.
    """
    if text and text[-1] in _SIZE_UNITS:
        return round(float(text[:-1]) * _SIZE_UNITS[text[-1]])
    return int(text)


def _ls_mode_string(s: FileStat) -> str:
    is_dir = s.type == FileType.DIRECTORY
    type_char = "d" if is_dir else "-"
    if s.mode is not None:
        perms = (_perm_triplet(s.mode >> 6) + _perm_triplet(s.mode >> 3) +
                 _perm_triplet(s.mode))
    else:
        perms = "rwxr-xr-x" if is_dir else "rw-r--r--"
    return f"{type_char}{perms}"


def _ls_time_string(modified: str | None) -> str:
    if not modified:
        return EPOCH_LS_TIME
    try:
        text = modified.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return EPOCH_LS_TIME
    month = _MONTHS[dt.month - 1]
    day = f"{dt.day:>2}"
    return f"{month} {day} {dt.hour:02d}:{dt.minute:02d}"


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
            out.append(f"{mode}\t-\t-\t{s.name}")
            continue
        mode = _ls_mode_string(s)
        size = raw_size.rjust(width)
        time = _ls_time_string(s.modified)
        who = str(s.uid) if s.uid is not None else owner
        grp = str(s.gid) if s.gid is not None else group
        out.append(f"{mode} 1 {who} {grp} {size} {time} {s.name}")
    return out


NUMERIC_PREFIX = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


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
