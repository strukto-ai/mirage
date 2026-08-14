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
from collections.abc import Iterable

from mirage.workspace.record.disk import DiskRecordClient
from mirage.workspace.session.store import SessionFields, SessionStore


class DiskSessionStore(SessionStore):
    """SessionStore backed by per-session files under one directory.

    One file per session at ``{root}/sessions/{session_id}.json``,
    lockfile CAS per record, so multiple local processes share one
    session table with the same generation contract as the Redis Lua
    script, with zero infrastructure.
    """

    def __init__(self, root: str) -> None:
        self._records = DiskRecordClient(root, "sessions/")

    async def load(self) -> dict[str, SessionFields]:
        return await self._records.load_all()

    async def set(self, session_id: str, fields: SessionFields) -> None:
        await self._records.put(session_id, fields)

    async def cas_set(self, session_id: str, fields: SessionFields,
                      expected_generation: int) -> bool:
        return await self._records.cas_put(session_id, fields,
                                           expected_generation)

    async def delete(self, session_ids: Iterable[str]) -> None:
        await self._records.delete(session_ids)

    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        stale = set(await self._records.list_names()) - set(entries)
        await self._records.delete(stale)
        await asyncio.gather(*(self._records.put(sid, fields)
                               for sid, fields in entries.items()))

    async def clear(self) -> None:
        await self._records.clear()

    async def close(self) -> None:
        await self._records.close()
