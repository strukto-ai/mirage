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

from dataclasses import dataclass
from enum import Enum

from mirage.ops.types import LiveFileIdentity


@dataclass(frozen=True, slots=True)
class Stamp:
    """What one file looked like the last time the agent saw it.

    Both fields, never one. ``identity`` is what the backend itself
    said, lifted off the read's own response, so it describes the bytes
    the agent was handed and not a concurrent writer's. ``content_hash``
    is the hash of those same bytes, which costs nothing on a path that
    already holds them and is the only comparator a mount without native
    markers has. An identity-only stamp would have nothing to say on
    such a mount, and one taken from a separate call after the read
    could stamp somebody else's version.

    ``content_hash`` is None in exactly one case: a post-write restamp
    whose backend answered with a marker. Hashing there would mean
    re-reading the file just written, which is the download this design
    exists to remove. The ladder reaches the hash rung from such a stamp
    only if the backend stopped reporting markers between that write and
    the next check; it then refuses the write rather than guessing, so a
    missing baseline costs a spurious refusal in a case that should not
    happen and never an accepted stale write.

    Args:
        identity (LiveFileIdentity | None): the backend's own markers
            for the bytes stamped, None when it reported none.
        content_hash (str | None): hash of the bytes stamped, None only
            for the marker-carrying write restamp described above.
    """

    identity: LiveFileIdentity | None
    content_hash: str | None


class MarkerMatch(Enum):
    """How two identities compared on the strongest marker they share."""

    SAME = "same"
    CHANGED = "changed"
    UNCOMPARABLE = "uncomparable"
