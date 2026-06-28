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


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def now_iso() -> str:
    return to_iso_z(datetime.now(timezone.utc))


def epoch_to_iso(seconds: float) -> str:
    """Convert unix epoch seconds to a second-precision UTC ISO-8601 string.

    Truncated to whole seconds so the Python and TypeScript converters
    produce byte-identical output.

    Args:
        seconds (float): unix epoch seconds (sub-second part is dropped).
    """
    return to_iso_z(datetime.fromtimestamp(int(seconds), tz=timezone.utc))
