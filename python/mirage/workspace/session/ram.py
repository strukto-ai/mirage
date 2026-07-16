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

from mirage.workspace.session.store import SessionFields, SessionStore


class RAMSessionStore(SessionStore):
    """In-process SessionStore; the default when none is configured.

    Sessions live and die with the process, matching today's behavior
    when persistence is not requested.
    """

    def __init__(self) -> None:
        self._entries: dict[str, SessionFields] = {}

    async def load(self) -> dict[str, SessionFields]:
        return {sid: dict(f) for sid, f in self._entries.items()}

    async def set(self, session_id: str, fields: SessionFields) -> None:
        self._entries[session_id] = dict(fields)

    async def delete(self, session_ids: Iterable[str]) -> None:
        for sid in session_ids:
            self._entries.pop(sid, None)

    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        self._entries = {sid: dict(f) for sid, f in entries.items()}

    async def clear(self) -> None:
        self._entries.clear()

    async def close(self) -> None:
        return None
