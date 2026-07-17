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

from abc import ABC, abstractmethod
from collections.abc import Iterable
from typing import Any

# One session's durable fields: the JSON-able ``Session.to_dict()``
# payload (session_id, cwd, env, created_at, mount_modes). Volatile
# shell state (functions, arrays, stdin buffers) never persists.
SessionFields = dict[str, Any]

# Shared cap for every generation-CAS retry loop (session flush,
# workspace meta): losing this many times in a row on a rarely written
# record is a bug to surface, not contention to absorb.
CAS_MAX_RETRIES = 3


def generation_of(fields: SessionFields | None) -> int:
    """A stored record's CAS generation; a missing record or a legacy
    record without the field counts as 0.

    Args:
        fields (SessionFields | None): the stored record, or None.
    """
    if fields is None:
        return 0
    return int(fields.get("generation", 0))


class SessionStore(ABC):
    """Storage seam for durable session state.

    Mirrors the NamespaceStore pattern: the SessionManager keeps the
    working copy in memory, hydrates once from the store, and writes
    through on mutation, so sessions (and the mount grants they carry)
    survive process restarts and are visible to any workspace pointed
    at the same store. RAM is the default; Redis shares sessions
    across processes, which is what lets a kernel tier bind a
    session-bound mountpoint created by another daemon.
    """

    @abstractmethod
    async def load(self) -> dict[str, SessionFields]:
        """Return every stored session, keyed by session id."""

    @abstractmethod
    async def set(self, session_id: str, fields: SessionFields) -> None:
        """Insert or update one session's fields."""

    @abstractmethod
    async def cas_set(self, session_id: str, fields: SessionFields,
                      expected_generation: int) -> bool:
        """Write one session iff its stored generation matches.

        Optimistic concurrency for the flush path: the write succeeds
        only when the stored record's ``generation`` equals
        ``expected_generation`` (a missing record and a record without
        the field both count as generation 0). ``replace_all`` stays
        unchecked on purpose: a snapshot restore wins wholesale.

        Args:
            session_id (str): session to write.
            fields (SessionFields): full record, already carrying the
                bumped generation.
            expected_generation (int): generation the caller last saw.

        Returns:
            bool: True when the write landed, False on conflict.
        """

    @abstractmethod
    async def delete(self, session_ids: Iterable[str]) -> None:
        """Remove the given sessions; missing ids are ignored."""

    @abstractmethod
    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        """Replace the full session table (snapshot restore)."""

    @abstractmethod
    async def clear(self) -> None:
        """Drop all stored sessions."""

    @abstractmethod
    async def close(self) -> None:
        """Release any underlying connections."""
