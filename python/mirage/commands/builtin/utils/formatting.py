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

from mirage.types import FileStat, FileType

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
           "Oct", "Nov", "Dec")

EPOCH_LS_TIME = "Jan  1 00:00"


def _human_size(n: int) -> str:
    for unit in ("B", "K", "M", "G", "T"):
        if n < 1024:
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}{unit}"
        n //= 1024
    return f"{n}P"


def _ls_mode_string(s: FileStat) -> str:
    is_dir = s.type == FileType.DIRECTORY
    type_char = "d" if is_dir else "-"
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
        mode = _ls_mode_string(s)
        size = raw_size.rjust(width)
        time = _ls_time_string(s.modified)
        out.append(f"{mode} 1 {owner} {group} {size} {time} {s.name}")
    return out
