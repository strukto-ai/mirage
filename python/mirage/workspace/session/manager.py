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
import copy
from collections.abc import Mapping
from typing import Any

from mirage.policy.profile import CompiledProfile
from mirage.policy.types import (AdmissionRules, Decision, HideReason,
                                 ProfileScript)
from mirage.secrets.config import EnvVar
from mirage.shell.variable import ShellVar
from mirage.types import MountMode
from mirage.workspace.record.types import CAS_MAX_RETRIES, generation_of
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.resolve import apply_profile, narrow
from mirage.workspace.session.session import (Session, vars_from_entries,
                                              vars_from_env)
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.store import SessionFields, SessionStore


def _holds_managed(session: Session) -> bool:
    """Whether any of the session's variables carries a pointer.

    Args:
        session (Session): the session to scan.
    """
    return any(var.managed is not None for var in session.vars.values())


def _merge_seed_vars(session: Session, seed_vars: Mapping[str,
                                                          ShellVar]) -> None:
    """Fill in template names a stored record predates.

    A record written before the workspace's env block gained an entry
    holds no var for the new name, so a session hydrated from the
    record alone could never reach the credential the deployment just
    configured. The record's own entries win per name -- an overwrite,
    a re-export, a stored pointer all round-trip untouched -- and only
    an absent name gains the seed. The records are frozen, so sharing
    them across sessions is safe.

    Args:
        session (Session): a session hydrated from the store.
        seed_vars (Mapping[str, ShellVar]): the workspace's template.
    """
    for name, var in seed_vars.items():
        if name not in session.vars:
            session.vars[name] = var


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
                 store: SessionStore | None = None,
                 seed_vars: dict[str, ShellVar] | None = None) -> None:
        self._default_id = default_session_id
        self._store = store if store is not None else RAMSessionStore()
        self._sessions: dict[str, Session] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # What the store last saw from us, per session id. Flush
        # compares against this to skip clean sessions without a
        # network read, and to avoid clobbering other writers.
        self._persisted: dict[str, SessionFields] = {}
        # The workspace's env block, translated: seeded onto the
        # default session now and copied into every created session as
        # its template. The records are frozen, so sharing them across
        # sessions is safe; each session gets its own dict.
        self._seed_vars = dict(seed_vars) if seed_vars else {}
        self._has_managed = any(var.managed is not None
                                for var in self._seed_vars.values())
        self._sessions[default_session_id] = Session(
            session_id=default_session_id, vars=dict(self._seed_vars))
        self._locks[default_session_id] = asyncio.Lock()
        self._loaded = False
        self._load_lock = asyncio.Lock()
        self._default_profile: CompiledProfile | None = None

    @property
    def has_managed_env(self) -> bool:
        """True once any session may hold a managed variable.

        The fill step is skipped entirely while this is False, so it is
        sticky-true: set by the workspace's env block, a created
        session's own entries, a hydrated record, or a snapshot, and
        never cleared (a detached name costs nothing extra -- the fill
        pass finds nothing to fetch and returns).
        """
        return self._has_managed

    @property
    def seed_vars(self) -> dict[str, ShellVar]:
        """The env template a created session starts from, copied."""
        return dict(self._seed_vars)

    def restore_seed(self, seed_vars: Mapping[str, ShellVar]) -> None:
        """Install the env template a snapshot or copy carried over.

        The template is constructor state, so `_from_state` rebuilds a
        workspace without it; existing sessions recover their own vars,
        but a session created afterward would start bare while its
        older siblings still carry every workspace env entry. Sticky on
        `has_managed_env`, like every other writer of it.

        Args:
            seed_vars (Mapping[str, ShellVar]): the restored template.
        """
        self._seed_vars = dict(seed_vars)
        self._has_managed = self._has_managed or any(
            var.managed is not None for var in self._seed_vars.values())

    @property
    def default_profile(self) -> CompiledProfile | None:
        """The document's default profile, as compiled for this workspace."""
        return self._default_profile

    @default_profile.setter
    def default_profile(self, compiled: CompiledProfile | None) -> None:
        """Shape the default session by the document's default profile.

        The workspace's own session is a session created without a
        name, so ``profiles.default`` reaches it the way it reaches
        ``create_session(id)``: applied in full now (modes, hides,
        exported env, cwd), and its narrowing stamped again after
        hydration, where a record from before the profile existed would
        otherwise wake the primary agent unrestricted. None (no default
        profile) leaves the session, and hydration, as they were.

        Args:
            compiled (CompiledProfile | None): the compiled default
                profile, infrastructure prefixes already folded in.
        """
        self._default_profile = compiled
        if compiled is not None:
            apply_profile(self._sessions[self._default_id], compiled)

    def commands_of(self, session_id: str) -> AdmissionRules | None:
        """The admission rules one session runs under
        (SessionCommandsQuery).

        The default profile's rules for an id this manager does not know,
        the empty id of an unbound door included (FUSE, the host's own
        ``ws.fs``), so a door that names no session is judged like a
        session that named no profile rather than judged not at all.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return (self._default_profile.commands
                    if self._default_profile is not None else None)
        return session.commands

    def script_of(self, session_id: str) -> ProfileScript | None:
        """The profile script one session runs under
        (SessionScriptsQuery).

        The default profile's for an id this manager does not know, the
        same fallback ``commands_of`` makes and for the same reason: a
        door that names no session is judged like a session that named
        no profile.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return (self._default_profile.script
                    if self._default_profile is not None else None)
        return session.script

    def hide_reasons_of(self, session_id: str) -> tuple[HideReason, ...]:
        """The operator's hide reasons for one session's profile.

        The default profile's for an id this manager does not know, the
        same fallback ``commands_of`` makes and for the same reason.
        Host-side only: nothing on the command surface renders these,
        because a reason on a nonexistent path would confirm the path
        exists.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return (self._default_profile.hide_reasons
                    if self._default_profile is not None else ())
        return session.hide_reasons

    def decision_sessions(self) -> tuple[str, ...]:
        """Every session id holding ledger records
        (SessionDecisionsQuery)."""
        return tuple(sid for sid, s in self._sessions.items() if s.decisions)

    def decisions_of(self, session_id: str) -> tuple[Decision, ...]:
        """The ledger records one session holds
        (SessionDecisionsQuery).

        Read off the registered session, never a fork, so a line
        running in a background copy sees the same answers.

        Args:
            session_id (str): the session.
        """
        return self.get(session_id).decisions

    def set_decisions(self, session_id: str, records: tuple[Decision,
                                                            ...]) -> None:
        """Replace one session's ledger records
        (SessionDecisionsQuery); durable at the next flush.

        Args:
            session_id (str): the session.
            records (tuple[Decision, ...]): the new list.
        """
        self.get(session_id).decisions = records

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
        set_cwd(self._sessions[self._default_id], value)

    @property
    def env(self) -> Mapping[str, str]:
        return self._sessions[self._default_id].env

    @env.setter
    def env(self, value: dict[str, str]) -> None:
        session = self._sessions[self._default_id]
        session.vars = vars_from_env(value)

    def adopt_default(self, session_id: str) -> None:
        """Re-key the default session to an externally decided id.

        Two callers: attach (the discovery record already names a
        default session, so the freshly minted placeholder re-keys
        before hydration lands the stored durable fields on it) and
        snapshot restore (the snapshot's default identity wins). The
        store itself is untouched; the next flush or snapshot replace
        writes the new key.

        Args:
            session_id (str): the default session id to adopt.
        """
        if session_id == self._default_id:
            return
        self._persisted.pop(self._default_id, None)
        if session_id in self._sessions:
            del self._sessions[self._default_id]
            del self._locks[self._default_id]
        else:
            session = self._sessions.pop(self._default_id)
            session.session_id = session_id
            self._sessions[session_id] = session
            self._locks[session_id] = self._locks.pop(self._default_id)
        self._default_id = session_id

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
                    set_cwd(default, stored.cwd)
                    default.vars = stored.vars
                    default.created_at = stored.created_at
                    default.mount_modes = stored.mount_modes
                    # The hidden shapes are durable restrictions, not
                    # scratch state: dropping them here would wake a
                    # restarted daemon unrestricted and let the next
                    # flush erase them from the store.
                    default.hidden_paths = stored.hidden_paths
                    default.shown_paths = stored.shown_paths
                    default.hidden_vars = stored.hidden_vars
                    default.hide_reasons = stored.hide_reasons
                    default.commands = stored.commands
                    default.script = stored.script
                    # The host's standing answers are session state
                    # like cwd: dropped here, an approved line would
                    # ask again after a restart and the next flush
                    # would erase the record from the store.
                    default.decisions = stored.decisions
                    default.generation = stored.generation
                    # Hydrated sessions start clean: baseline what the
                    # store holds so the next flush skips them.
                    self._persisted[sid] = copy.deepcopy(default.to_dict())
                    # The document outranks the record for the fields
                    # no line can edit; stamped after the baseline so a
                    # stale record is rewritten on the next flush.
                    if self._default_profile is not None:
                        narrow(default, self._default_profile)
                    # Same order for the same reason: an env entry the
                    # record predates lands durably on the next flush.
                    _merge_seed_vars(default, self._seed_vars)
                    self._has_managed = (self._has_managed
                                         or _holds_managed(default))
                    continue
                if sid in self._sessions:
                    continue
                session = Session.from_dict(fields)
                self._sessions[sid] = session
                self._locks[sid] = asyncio.Lock()
                self._persisted[sid] = copy.deepcopy(session.to_dict())
                _merge_seed_vars(session, self._seed_vars)
                self._has_managed = (self._has_managed
                                     or _holds_managed(session))
            self._loaded = True

    async def flush(self) -> None:
        """Write dirty sessions through the store's generation gate."""
        for session in list(self._sessions.values()):
            async with self._locks[session.session_id]:
                await self._flush_one(session)

    async def settle(self) -> None:
        """Wait for admitted session writes before their store closes."""
        for lock in list(self._locks.values()):
            async with lock:
                pass

    async def _flush_one(self, session: Session) -> None:
        """Persist one session, retrying when another writer races us."""
        sid = session.session_id
        if session.to_dict() == self._persisted.get(sid):
            return  # clean: the store already has exactly this state
        for _ in range(CAS_MAX_RETRIES):
            expected = session.generation
            session.generation = expected + 1
            fields = session.to_dict()
            if await self._store.cas_set(sid, fields, expected):
                # Deep copy: to_dict() returns nested dicts the caller
                # may go on to mutate, and the baseline this is compared
                # against must stay frozen at what was written.
                self._persisted[sid] = copy.deepcopy(fields)
                return
            # Lost the race: adopt the winner's generation and retry
            # our content on top (last-writer-wins until a merge
            # policy exists).
            session.generation = expected
            stored = (await self._store.load()).get(sid)
            if stored is not None:
                session.generation = generation_of(stored)
        raise RuntimeError(
            f"session {sid!r} flush kept conflicting with another writer")

    async def replace_from_snapshot(self, sessions: list[Session]) -> None:
        """Adopt a snapshot's session table and replace the store.

        The snapshot wins over prior store contents, mirroring
        ``Namespace.replace_nodes``.
        """
        self._loaded = True
        entries = {s.session_id: s.to_dict() for s in self._sessions.values()}
        for session in sessions:
            entries[session.session_id] = session.to_dict()
            self._has_managed = self._has_managed or _holds_managed(session)
        await self._store.replace_all(entries)
        self._persisted = copy.deepcopy(entries)

    def create(
        self,
        session_id: str,
        mount_modes: dict[str, MountMode] | None = None,
        env: Mapping[str, str | EnvVar | Mapping[str, Any]] | None = None
    ) -> Session:
        """Create a session, seeded with the workspace's env template.

        Args:
            session_id (str): unique id for the session.
            mount_modes (dict[str, MountMode] | None): per-mount modes.
            env (Mapping[str, str | EnvVar | Mapping[str, Any]] | None):
                this session's own env entries, literal or managed,
                merged over the template (session entries win).
        """
        if session_id in self._sessions:
            raise ValueError(f"Session {session_id!r} already exists")
        seeded = dict(self._seed_vars)
        if env is not None:
            seeded.update(vars_from_entries(env))
        session = Session(session_id=session_id,
                          mount_modes=mount_modes,
                          vars=seeded)
        self._has_managed = self._has_managed or _holds_managed(session)
        self._sessions[session_id] = session
        self._locks[session_id] = asyncio.Lock()
        return session

    def get(self, session_id: str) -> Session:
        return self._sessions[session_id]

    async def set_profile(self, session_id: str,
                          compiled: CompiledProfile) -> Session:
        """Replace restrictions without resetting the session's scratch state.

        Args:
            session_id (str): an existing, hydrated session.
            compiled (CompiledProfile): its replacement profile.
        """
        async with self._locks[session_id]:
            session = self.get(session_id)
            candidate = copy.copy(session)
            narrow(candidate, compiled)
            await self._flush_one(candidate)
            narrow(session, compiled)
            session.generation = candidate.generation
            if session_id == self._default_id:
                self._default_profile = compiled
            return session

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
        self._persisted.pop(session_id, None)
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
