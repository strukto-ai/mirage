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

from mirage.core.posix.types import PosixEntry
from mirage.utils.dates import settled


def token_of(entry: PosixEntry) -> str | None:
    """An entry's fingerprint, from what find printed for it: its size and
    the millisecond its last change landed at.

    Two same-size writes in one millisecond share both numbers, so an
    entry that has not ``settled`` by this host's clock when find was
    asked gets none, which takes the machine's clock to agree with this
    one within the racy window.

    Args:
        entry (PosixEntry): the entry, with the time find was asked.
    """
    if not settled(entry.mtime_ms * 1_000_000, entry.asked_ns):
        return None
    return f"{entry.size}:{entry.mtime_ms}"
