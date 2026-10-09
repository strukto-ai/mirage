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

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Iterable

from mirage.workspace.record.types import RecordClient, RecordFields

# One session's durable fields: the JSON-able ``SessionState.to_dict()``
# payload, including function source and readonly metadata. Parser trees,
# running jobs and stream handles never enter this record.
# A session's stored shape is one keyed record like any other, so the
# alias and the CAS helpers come from the record tier rather than being
# restated here. The name stays SessionFields at this seam because that
# is what a SessionStore stores.
SessionFields = RecordFields


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
    async def cas_set(
        self, session_id: str, fields: SessionFields, expected_generation: int
    ) -> bool:
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


class RecordSessionStore(SessionStore):
    """A SessionStore over a keyed-record client, one record per session.

    The disk and S3 stores differ only in the client they hand in.

    Args:
        records (RecordClient): the client holding the session records.
    """

    def __init__(self, records: RecordClient) -> None:
        self._records = records

    async def load(self) -> dict[str, SessionFields]:
        names = await self._records.list_names()
        records = await asyncio.gather(
            *(self._records.get(name) for name in names)
        )
        return {
            name: fields
            for name, (fields, _) in zip(names, records)
            if fields is not None
        }

    async def set(self, session_id: str, fields: SessionFields) -> None:
        await self._records.put(session_id, fields)

    async def cas_set(
        self, session_id: str, fields: SessionFields, expected_generation: int
    ) -> bool:
        return await self._records.cas_put(
            session_id, fields, expected_generation
        )

    async def delete(self, session_ids: Iterable[str]) -> None:
        await self._records.delete(session_ids)

    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        stale = set(await self._records.list_names()) - set(entries)
        await self._records.delete(stale)
        await asyncio.gather(
            *(
                self._records.put(sid, fields)
                for sid, fields in entries.items()
            )
        )

    async def clear(self) -> None:
        await self._records.clear()

    async def close(self) -> None:
        await self._records.close()
