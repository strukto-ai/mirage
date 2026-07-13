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

from mirage.types import MountMode
from mirage.workspace.session.session import Session


class SessionManager:

    def __init__(self, default_session_id: str) -> None:
        self._default_id = default_session_id
        self._sessions: dict[str, Session] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._sessions[default_session_id] = Session(
            session_id=default_session_id)
        self._locks[default_session_id] = asyncio.Lock()

    @property
    def default_id(self) -> str:
        return self._default_id

    @property
    def cwd(self) -> str:
        return self._sessions[self._default_id].cwd

    @cwd.setter
    def cwd(self, value: str) -> None:
        self._sessions[self._default_id].cwd = value

    @property
    def env(self) -> dict[str, str]:
        return self._sessions[self._default_id].env

    @env.setter
    def env(self, value: dict[str, str]) -> None:
        self._sessions[self._default_id].env = value

    def create(self,
               session_id: str,
               mount_grants: dict[str, MountMode] | None = None) -> Session:
        if session_id in self._sessions:
            raise ValueError(f"Session {session_id!r} already exists")
        session = Session(session_id=session_id, mount_grants=mount_grants)
        self._sessions[session_id] = session
        self._locks[session_id] = asyncio.Lock()
        return session

    def get(self, session_id: str) -> Session:
        return self._sessions[session_id]

    def list(self) -> list[Session]:
        return list(self._sessions.values())

    async def close(self, session_id: str) -> None:
        if session_id == self._default_id:
            raise ValueError("Cannot close the default session")
        if session_id not in self._sessions:
            raise KeyError(session_id)
        async with self._locks[session_id]:
            del self._sessions[session_id]
        del self._locks[session_id]

    async def close_all(self) -> None:
        session_ids = [
            sid for sid in self._sessions if sid != self._default_id
        ]
        for sid in session_ids:
            await self.close(sid)

    def lock_for(self, session_id: str) -> asyncio.Lock:
        return self._locks[session_id]
