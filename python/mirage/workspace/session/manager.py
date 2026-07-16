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
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.session import Session
from mirage.workspace.session.store import SessionStore


class SessionManager:
    """Owns the live session table over a storage-agnostic SessionStore.

    Mirrors the Namespace/NamespaceStore split: sessions are worked on
    in memory (creation stays synchronous), the store hydrates once at
    the first async entry point, and durable fields flush back at async
    boundaries (end of execute, snapshot, explicit persist). ``close``
    deletes from the store — closing a session revokes it everywhere —
    while process shutdown leaves stored sessions in place.
    """

    def __init__(self,
                 default_session_id: str,
                 store: SessionStore | None = None) -> None:
        self._default_id = default_session_id
        self._store = store if store is not None else RAMSessionStore()
        self._sessions: dict[str, Session] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._sessions[default_session_id] = Session(
            session_id=default_session_id)
        self._locks[default_session_id] = asyncio.Lock()
        self._loaded = False
        self._load_lock = asyncio.Lock()

    @property
    def default_id(self) -> str:
        return self._default_id

    @property
    def store(self) -> SessionStore:
        return self._store

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

    async def ensure_loaded(self) -> None:
        """Hydrate sessions from the store once.

        Stored sessions fill in ids this process has not created;
        locally created sessions win a conflict (they overwrite the
        store on the next flush). The default session adopts the stored
        durable fields so a restarted daemon keeps its cwd/env.
        """
        if self._loaded:
            return
        async with self._load_lock:
            if self._loaded:
                return
            entries = await self._store.load()
            for sid, fields in entries.items():
                if sid == self._default_id:
                    stored = Session.from_dict(fields)
                    default = self._sessions[self._default_id]
                    default.cwd = stored.cwd
                    default.env = stored.env
                    default.created_at = stored.created_at
                    default.mount_modes = stored.mount_modes
                    continue
                if sid in self._sessions:
                    continue
                self._sessions[sid] = Session.from_dict(fields)
                self._locks[sid] = asyncio.Lock()
            self._loaded = True

    async def flush(self) -> None:
        """Write every session's durable fields through to the store."""
        for session in list(self._sessions.values()):
            await self._store.set(session.session_id, session.to_dict())

    async def replace_from_snapshot(self, sessions: list[Session]) -> None:
        """Adopt a snapshot's session table and replace the store.

        The snapshot wins over prior store contents, mirroring
        ``Namespace.replace_nodes``.
        """
        self._loaded = True
        entries = {s.session_id: s.to_dict() for s in self._sessions.values()}
        for session in sessions:
            entries[session.session_id] = session.to_dict()
        await self._store.replace_all(entries)

    def create(self,
               session_id: str,
               mount_modes: dict[str, MountMode] | None = None) -> Session:
        if session_id in self._sessions:
            raise ValueError(f"Session {session_id!r} already exists")
        session = Session(session_id=session_id, mount_modes=mount_modes)
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
        await self._store.delete([session_id])

    async def close_all(self) -> None:
        session_ids = [
            sid for sid in self._sessions if sid != self._default_id
        ]
        for sid in session_ids:
            await self.close(sid)

    async def close_store(self) -> None:
        await self._store.close()

    def lock_for(self, session_id: str) -> asyncio.Lock:
        return self._locks[session_id]
