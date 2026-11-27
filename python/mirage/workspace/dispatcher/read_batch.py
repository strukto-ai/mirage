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

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from mirage.mount.changes import RecentChanges

# The most bytes a read-ahead fetches for one file, as its listing sizes
# it, and the most one held batch holds. A larger file is left to the read
# that names it, and so is a file the listing does not size, unless its
# store reads a batch (``read_many``), which leaves out what passes this
# itself.
READ_AHEAD_BYTES = 1 << 20


@dataclass(frozen=True, slots=True)
class HeldFile:
    """A file a read-ahead read for its caller.

    Args:
        followed (str): the virtual path the read reached, links
            followed.
        data (bytes): the file's stored bytes.
    """

    followed: str
    data: bytes


@dataclass(slots=True)
class ReadBatch:
    """What a read-ahead (``read_many``) answers.

    On a mount that keeps reads it warms the read cache, and ``kept`` says
    so. On one that holds its data locally it reads the files for the
    caller instead, past each one's checks, ``holds`` says so, and it
    holds them here: each is
    handed out once, while no change has reached it since ``count``, as
    the workspace's changes numbered them before the reads, and no link
    has changed since, which a path may have followed past its own name
    and the file it reached. A file the batch left out is read on its
    own.

    Args:
        kept (bool): a file of the batch is on a mount that keeps reads.
        holds (bool): a file of the batch is on a mount that holds its
            data locally, which reads it for the caller, whether or not it
            was held.
        held (dict[str, HeldFile]): the files read, by the virtual path
            the caller named.
        changes (RecentChanges | None): the workspace's changes; None
            while nothing is held.
        count (int): how many changes it had noted before the reads.
        links (Mapping[str, str] | None): the namespace's links, each
            with its target, as they stood before the reads; None while
            nothing is held.
        current_links (Callable[[], Mapping[str, str]] | None): answers
            the namespace's links as they stand, a new table once one
            changed; None while nothing is held.
    """

    kept: bool = False
    holds: bool = False
    held: dict[str, HeldFile] = field(default_factory=dict)
    changes: RecentChanges | None = None
    count: int = 0
    links: Mapping[str, str] | None = None
    current_links: Callable[[], Mapping[str, str]] | None = None

    def take(self, virtual: str) -> bytes | None:
        """The bytes held for ``virtual``, handed out once; None when none
        are held, or a change has reached the file or a link has changed
        since they were read.

        Args:
            virtual (str): the path as the caller names it.
        """
        held = self.held.pop(virtual, None)
        if held is None or self.changes is None:
            return None
        if (
            self.current_links is not None
            and self.current_links() is not self.links
        ):
            return None
        if self.changes.reached_since(self.count, (virtual, held.followed)):
            return None
        return held.data
