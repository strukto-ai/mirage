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

from datetime import date, datetime, timedelta, timezone


def _epoch_seconds(day: date) -> int:
    return int(
        datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp()
    )


def span_to_gmail_query(start: date, end: date) -> str:
    """A Gmail date filter for a half-open range of UTC days.

    The bounds are epoch seconds rather than ``YYYY/MM/DD`` because
    Gmail reads a written date as "midnight on that date in the PST
    timezone" and names seconds as the way to mean any other zone, while
    a message lands in a day directory by its UTC ``internalDate``. The
    two disagree by the account's offset, so a written date would leave
    the first hours of the requested day outside the query and every
    message in them out of the listing. The lower bound is a second
    early because the operator's inclusivity at the exact second is not
    documented: an extra message from the day before is dropped by the
    bucketing, a missing one is not recoverable.

    Args:
        start (date): first UTC day, inclusive.
        end (date): last UTC day, exclusive.
    """
    return f"after:{_epoch_seconds(start) - 1} before:{_epoch_seconds(end)}"


def date_dir_to_gmail_query(name: str) -> str | None:
    parts = name.split("-")
    if len(parts) != 3:
        return None
    if not (len(parts[0]) == 4 and len(parts[1]) == 2 and len(parts[2]) == 2):
        return None
    try:
        d = date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    return span_to_gmail_query(d, d + timedelta(days=1))
