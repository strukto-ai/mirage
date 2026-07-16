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
