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


def utc_date_folder(ts: float | None = None) -> str:
    t = (datetime.now(timezone.utc) if ts is None else datetime.fromtimestamp(
        ts, timezone.utc))
    return t.strftime("%Y-%m-%d")


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


def in_mtime_window(timestamp: float | None, mtime_min: float | None,
                    mtime_max: float | None) -> bool:
    if mtime_min is None and mtime_max is None:
        return True
    if timestamp is None:
        return False
    if mtime_min is not None and timestamp < mtime_min:
        return False
    if mtime_max is not None and timestamp > mtime_max:
        return False
    return True


def matches_mtime(value: str | None, mtime_min: float | None,
                  mtime_max: float | None) -> bool:
    return in_mtime_window(iso_timestamp(value), mtime_min, mtime_max)
