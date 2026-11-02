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

from mirage.utils.glob_walk import glob_span


def glob_to_modified_range(pattern: str | None) -> tuple[str, str] | None:
    """Translate a date-prefixed glob into an RFC3339 modifiedTime range.

    Drive's own spelling of the span ``glob_span`` reads; a caller
    bucketing in a named time zone builds its own bounds from the dates
    instead, since UTC instants would shift the window by the offset.

    Args:
        pattern (str | None): the glob as typed, or None.

    Returns:
        tuple[str, str] | None: (start, end) in UTC, or None when the glob
        does not start with a date prefix.
    """
    span = glob_span(pattern)
    if span is None:
        return None
    start, end = span
    return f"{start:%Y-%m-%d}T00:00:00Z", f"{end:%Y-%m-%d}T00:00:00Z"
