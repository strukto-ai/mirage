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

from collections.abc import Iterable
from typing import Generic, TypeVar

T = TypeVar("T")


class FileTable(Generic[T]):
    """Open handles by integer id.

    The table every encoder used to hand-roll beside its handle type:
    ids are dense from ``first_id`` upward and never reused within a
    run. Generic because the entries differ (a wasi fd table holds
    directory and stdio entries beside file handles, a FUSE core holds
    its kernel-dialect handle), while the bookkeeping never does.

    Args:
        first_id (int): the first id handed out; wasi starts above its
            three stdio fds and the preopen, FUSE starts at 1.
    """

    def __init__(self, first_id: int = 1) -> None:
        self._next = first_id
        self._entries: dict[int, T] = {}

    def add(self, entry: T) -> int:
        """Track an entry under a fresh id and return the id.

        Args:
            entry (T): the entry to track.
        """
        fd = self._next
        self._next += 1
        self._entries[fd] = entry
        return fd

    def get(self, fd: int) -> T | None:
        """The entry under `fd`, or None.

        Args:
            fd (int): the id to look up.
        """
        return self._entries.get(fd)

    def pop(self, fd: int) -> T | None:
        """Remove and return the entry under `fd`, or None.

        Args:
            fd (int): the id to release.
        """
        return self._entries.pop(fd, None)

    def set(self, fd: int, entry: T) -> None:
        """Place an entry under an explicit id.

        Args:
            fd (int): the id to occupy (wasi seeds stdio at 0-2 and
                renumbers onto guest-chosen ids).
            entry (T): the entry to track.
        """
        self._entries[fd] = entry

    def values(self) -> Iterable[T]:
        """Every tracked entry."""
        return self._entries.values()

    def __contains__(self, fd: int) -> bool:
        return fd in self._entries
