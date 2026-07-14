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

from datetime import date, timedelta

from mirage.utils.glob_walk import GLOB_CHARS


def _iso(d: date) -> str:
    return d.strftime("%Y-%m-%dT00:00:00Z")


def glob_to_modified_range(pattern: str | None) -> tuple[str, str] | None:
    if not pattern:
        return None
    meta_index = -1
    for ch in GLOB_CHARS:
        idx = pattern.find(ch)
        if idx != -1 and (meta_index == -1 or idx < meta_index):
            meta_index = idx
    if meta_index == -1:
        return None
    prefix = pattern[:meta_index]
    prefix = prefix.rstrip("_-")
    parts = prefix.split("-")
    try:
        if len(parts) == 1 and len(parts[0]) == 4:
            year = int(parts[0])
            start = date(year, 1, 1)
            end = date(year + 1, 1, 1)
        elif len(parts) == 2 and len(parts[0]) == 4 and len(parts[1]) == 2:
            year = int(parts[0])
            month = int(parts[1])
            start = date(year, month, 1)
            if month == 12:
                end = date(year + 1, 1, 1)
            else:
                end = date(year, month + 1, 1)
        elif (len(parts) == 3 and len(parts[0]) == 4 and len(parts[1]) == 2
              and len(parts[2]) == 2):
            year = int(parts[0])
            month = int(parts[1])
            day = int(parts[2])
            start = date(year, month, day)
            end = start + timedelta(days=1)
        else:
            return None
    except ValueError:
        return None
    return _iso(start), _iso(end)
