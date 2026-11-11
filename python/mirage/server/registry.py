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
import errno
import logging
import math
import os
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable

from mirage import Workspace, WorkspaceRunner
from mirage.config import load_policy_file
from mirage.io.network import NetworkRule, NetworkSetting, network_rule
from mirage.policy.base import Policy
from mirage.policy.policies import Policies
from mirage.policy.script import ScriptPolicy
from mirage.policy.types import (
    Deny,
    Explanation,
    Outcome,
    PolicyCaller,
    ProfileScripts,
    WorkspaceContext,
)
from mirage.server.constants import MAX_SESSIONS
from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import (
    ENV_GRACEFUL_TIMEOUT,
    ENV_MAX_ENV,
    ENV_MAX_LINE_SECONDS,
    ENV_MAX_MEMORY,
    ENV_MAX_PROCESSES,
    ENV_MAX_SESSIONS,
    ENV_MAX_WORKSPACES,
    ENV_POLICY_FILE,
)
from mirage.server.paths import mirage_home
from mirage.server.requests import RequestTable
from mirage.types import Ceilings, JsonValue
from mirage.utils.ids import new_workspace_id
from mirage.utils.size import parse_limit
from mirage.workspace.record.disk import DiskRecordClient
from mirage.workspace.store.base import WorkspaceStateStore

logger = logging.getLogger(__name__)

# Under the daemon's state root: one record per workspace id naming the
# account that owns it.
OWNERS_PREFIX = "owners"
# Beside it: one record per workspace id holding the config it was created
# from, as written, which ``start`` builds again.
CONFIGS_PREFIX = "configs"


class Claim(StrEnum):
    """What a create's claim on an id found."""

    NEW = "new"
    HELD = "held"
    TAKEN = "taken"


class Forget(StrEnum):
    """What a delete of a stopped workspace did."""

    DONE = "done"
    BUSY = "busy"
    GONE = "gone"
    HELD = "held"


class WorkspaceEntry:
    """One registered workspace.

    Args:
        workspace_id (str): the registry id.
        runner (WorkspaceRunner): the runner driving it.
        owner (str | None): the account that created it; None when it
            was created by a caller with no account.
    """

    def __init__(
        self,
        workspace_id: str,
        runner: WorkspaceRunner,
        owner: str | None = None,
    ) -> None:
        self.id = workspace_id
        self.runner = runner
        self.owner = owner
        self.created_at = time.time()
        self.config_digest: str | None = None
        self.accepting_jobs = True
        # The server's policy file's programs, as this workspace runs
        # them; None when the file names none past pre_workspace.
        self.programs: ScriptPolicy | None = None


def resolve_max_workspaces(max_workspaces: int | None = None) -> int | None:
    """The most workspaces the server holds at once: ``max_workspaces``
    when given, else ``$MIRAGE_MAX_WORKSPACES``, else the
    ``max_workspaces`` key in config.toml's ``[daemon]`` table, else no
    cap. Mirrors TypeScript's ``resolveMaxWorkspaces``.

    Args:
        max_workspaces (int | None): the cap the caller set.

    Raises:
        DaemonConfigError: the cap is not a positive whole number.
    """
    return _cap(max_workspaces, ENV_MAX_WORKSPACES, "max_workspaces")


def resolve_max_sessions(max_sessions: int | None = None) -> int:
    """The most sessions each workspace holds, its default session among
    them: ``max_sessions`` when given, else ``$MIRAGE_MAX_SESSIONS``, else
    the ``max_sessions`` key in config.toml's ``[daemon]`` table, else
    ``MAX_SESSIONS``. Mirrors TypeScript's ``resolveMaxSessions``.

    Args:
        max_sessions (int | None): the cap the caller set.

    Raises:
        DaemonConfigError: the cap is not a positive whole number.
    """
    cap = _cap(max_sessions, ENV_MAX_SESSIONS, "max_sessions")
    return MAX_SESSIONS if cap is None else cap


def resolve_ceilings(
    max_memory: str | int | None = None,
    max_processes: int | None = None,
    max_line_seconds: float | None = None,
    max_env: str | int | None = None,
) -> Ceilings:
    """The most any workspace the server holds may set: each ceiling
    from its argument when given, else its ``$MIRAGE_MAX_*`` variable,
    else its key in config.toml's ``[daemon]`` table, else none. Mirrors
    TypeScript's ``resolveCeilings``.

    Args:
        max_memory (str | int | None): the most a workspace's
            ``max_memory`` reaches, as a size.
        max_processes (int | None): the most a session's
            ``processes.max`` reaches.
        max_line_seconds (float | None): the most seconds a line runs.
        max_env (str | int | None): the most a workspace's ``max_env``
            reaches, as a size.

    Raises:
        DaemonConfigError: a ceiling is not a positive size, whole
            number or number of seconds.
    """
    value = _setting(
        max_line_seconds, ENV_MAX_LINE_SECONDS, "max_line_seconds"
    )
    seconds = None if value is None else _to_seconds(value)
    if seconds is not None and seconds <= 0:
        raise DaemonConfigError(
            f"max_line_seconds must be a number of seconds above 0, "
            f"got {value!r}"
        )
    return Ceilings(
        max_memory=_size(max_memory, ENV_MAX_MEMORY, "max_memory"),
        max_processes=_cap(max_processes, ENV_MAX_PROCESSES, "max_processes"),
        max_line_seconds=seconds,
        max_env=_size(max_env, ENV_MAX_ENV, "max_env"),
    )


def _size(given: str | int | None, env: str, key: str) -> int | None:
    """A positive size: ``given``, else the ``env`` variable, else
    ``key`` in config.toml's ``[daemon]`` table, else None. Mirrors
    TypeScript's ``size``.

    Args:
        given (str | int | None): the value the caller passed.
        env (str): the variable that sets it.
        key (str): the config key that sets it.

    Raises:
        DaemonConfigError: the value is not a size above 0.
    """
    value = _setting(given, env, key)
    try:
        size = None if value is None else parse_limit(value, key)
    except ValueError as exc:
        raise DaemonConfigError(str(exc)) from exc
    if size is not None and size < 1:
        raise DaemonConfigError(f"{key} must be above 0, got {value!r}")
    return size


def _setting(given: Any, env: str, key: str) -> Any:
    """A host setting as given: ``given``, else the ``env`` variable,
    else ``key`` in config.toml's ``[daemon]`` table; None when none of
    them sets it.

    Args:
        given (Any): the value the caller set.
        env (str): the environment variable that sets it.
        key (str): the ``[daemon]`` key that sets it.
    """
    if given is not None:
        return given
    value = os.environ.get(env) or read_daemon_table(mirage_home()).get(key)
    return None if value is None or value == "" else value


def _to_seconds(value: Any) -> float:
    """A number of seconds as written, -1 for one that is not.

    Args:
        value (Any): the setting as given.
    """
    try:
        seconds = float(value) if not isinstance(value, bool) else -1.0
    except ValueError:
        return -1.0
    return seconds if math.isfinite(seconds) else -1.0


def _cap(given: int | None, env: str, key: str) -> int | None:
    """A positive whole cap: ``given``, else the ``env`` variable, else
    ``key`` in config.toml's ``[daemon]`` table, else None for no cap.

    Args:
        given (int | None): the cap the caller set.
        env (str): the environment variable that sets it.
        key (str): the ``[daemon]`` key that sets it.

    Raises:
        DaemonConfigError: the cap is not a positive whole number.
    """
    value = _setting(given, env, key)
    if value is None:
        return None
    try:
        cap = int(value) if not isinstance(value, (bool, float)) else 0
    except ValueError:
        cap = 0
    if cap < 1:
        raise DaemonConfigError(
            f"{key} must be a positive whole number, got {value!r}"
        )
    return cap


def resolve_graceful_timeout(graceful_timeout: float | None = None) -> float:
    """How long a shutdown lets running lines finish before it cancels
    them: ``graceful_timeout`` when given, else ``$MIRAGE_GRACEFUL_TIMEOUT``,
    else the ``graceful_timeout`` key in config.toml's ``[daemon]`` table,
    else 0. Mirrors TypeScript's ``resolveGracefulTimeout``.

    Args:
        graceful_timeout (float | None): the seconds the caller set.

    Raises:
        DaemonConfigError: the value is not a number of seconds, 0 or
            more.
    """
    value = _setting(
        graceful_timeout, ENV_GRACEFUL_TIMEOUT, "graceful_timeout"
    )
    if value is None:
        return 0.0
    seconds = _to_seconds(value)
    if seconds < 0:
        raise DaemonConfigError(
            f"graceful_timeout must be a number of seconds, 0 or more, "
            f"got {value!r}"
        )
    return seconds


def resolve_policy_file(
    policy_file: str | Path | None = None,
) -> ProfileScripts:
    """The server's policy programs: those of ``policy_file`` when
    given, else of ``$MIRAGE_POLICY_FILE``, else of the ``policy_file``
    key in config.toml's ``[daemon]`` table, read next to it, else none.
    Mirrors TypeScript's ``resolvePolicyFile``.

    Args:
        policy_file (str | Path | None): the file the caller named.

    Raises:
        ValueError: the file is not a mapping of method to programs.
        FileNotFoundError: the file or a script it names is missing.
    """
    path: str | Path | None = policy_file or os.environ.get(ENV_POLICY_FILE)
    if not path:
        named = read_daemon_table(mirage_home()).get("policy_file")
        if not named:
            return {}
        path = mirage_home() / named
    return load_policy_file(path)


class _Programs:
    """The server's policy programs, which every session answers to."""

    def __init__(self, programs: ProfileScripts) -> None:
        self._programs = programs

    def scripts_of(self, session_id: str) -> ProfileScripts:
        return self._programs


class WorkspaceRegistry:
    """In-memory map of workspace_id -> WorkspaceRunner.

    Owns the lifecycle for each workspace inside the daemon process:
    register on create, drop on delete, and trip an idle-shutdown
    event when the registry empties for ``idle_grace_seconds``.

    Threading: the underlying ``dict`` is mutated only from the FastAPI
    server loop (the same loop the registry is constructed on), so no
    external lock is required.
    """

    def __init__(
        self,
        idle_grace_seconds: float = 30.0,
        exit_event: asyncio.Event | None = None,
        accounts_required: bool = False,
        owners: DiskRecordClient | None = None,
        configs: DiskRecordClient | None = None,
        max_workspaces: int | None = None,
        policies: Sequence[Policy] = (),
        programs: ProfileScripts | None = None,
        max_sessions: int | None = None,
        ceilings: Ceilings | None = None,
    ) -> None:
        """Construct an empty registry.

        Args:
            idle_grace_seconds (float): seconds to wait after the last
                workspace is removed before signalling exit. ``0``
                means exit immediately on empty.
            exit_event (asyncio.Event | None): event to set when the
                idle timer fires. Defaults to a fresh event.
            accounts_required (bool): refuse callers with no account
                (jwt mode); otherwise such a caller may use every
                workspace.
            owners (DiskRecordClient | None): where each workspace id's
                owning account is kept across restarts, so a stored
                workspace is only ever reopened by its owner. None keeps
                ownership in memory.
            configs (DiskRecordClient | None): where each workspace id's
                config is kept, so a stopped workspace can be started
                again. None keeps none, and nothing can be started.
            max_workspaces (int | None): the most workspaces held at
                once, those being built among them; None for no cap.
            policies (Sequence[Policy]): the server's own policies, which
                answer ``pre_workspace`` and are registered on every
                workspace it builds, after the workspace's own.
            programs (ProfileScripts | None): the server's policy
                programs, by method, which answer the same way.
            max_sessions (int | None): the most sessions each workspace
                holds, its default among them; None for no cap.
            ceilings (Ceilings | None): the most any workspace it builds
                may set, which every create, clone and load is held to.
        """
        self._entries: dict[str, WorkspaceEntry] = {}
        self.max_workspaces = max_workspaces
        self.max_sessions = max_sessions
        self.ceilings = ceilings or Ceilings()
        self.policies = tuple(policies)
        self._programs = {
            method: scripts
            for method, scripts in (programs or {}).items()
            if method != "pre_workspace"
        }
        self._admission_programs = ScriptPolicy(
            _Programs(dict(programs or {}))
        )
        self._admission = Policies([*self.policies, self._admission_programs])
        self.jobs = RequestTable()
        self.accounts_required = accounts_required
        self._owners = owners
        self._configs = configs
        self._removals: dict[str, asyncio.Task[WorkspaceEntry]] = {}
        # Stopped workspaces being deleted, whose ids stay reserved
        # meanwhile.
        self._forgets: set[str] = set()
        self._creates: dict[str, tuple[str, asyncio.Future[None]]] = {}
        self.idle_grace_seconds = idle_grace_seconds
        self.exit_event = (
            exit_event if exit_event is not None else asyncio.Event()
        )
        self._idle_task: asyncio.Task[Any] | None = None

    async def refusal(
        self, config: dict[str, JsonValue], account: str | None
    ) -> Deny | None:
        """The server's refusal of a workspace about to be built, None
        when its policies let it.

        Args:
            config (dict[str, JsonValue]): the config as the caller wrote
                it: a create's whole config, a clone's or a load's
                override.
            account (str | None): the account the request signed in as.
        """
        return await self._admission.pre_workspace(
            _workspace_context(config, account)
        )

    async def explanation(
        self, config: dict[str, JsonValue], account: str | None
    ) -> Explanation:
        """What the server's policies say of a workspace about to be
        built, every answer included, without building it.

        Args:
            config (dict[str, JsonValue]): the config as the caller wrote
                it.
            account (str | None): the account the request signed in as.
        """
        answers = await self._admission.answers(
            "pre_workspace", _workspace_context(config, account)
        )
        deny = next((a for a in answers if isinstance(a, Deny)), None)
        return Explanation(
            outcome=Outcome.ALLOW if deny is None else Outcome.DENY,
            reason="" if deny is None else deny.reason,
            answers=answers,
        )

    def rule_for(self, setting: NetworkSetting = True) -> NetworkRule | None:
        """The rule a workspace with this ``network`` is held to here: its
        own setting, with the cloud metadata addresses refused in jwt mode
        (``accounts_required``); None when nothing limits it.

        Args:
            setting (NetworkSetting): the workspace's ``network``.

        Raises:
            ValueError: the setting or one of its entries is not valid.
        """
        return network_rule(setting, self.accounts_required)

    def __contains__(self, workspace_id: str) -> bool:
        return workspace_id in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    @asynccontextmanager
    async def creating(
        self, workspace_id: str, config_digest: str
    ) -> AsyncIterator[bool]:
        """Run one create of ``workspace_id`` at a time.

        A create of the same config that arrives while another is
        building waits for it, then finds the workspace it registered,
        rather than building a second over its state; it would stall on
        the same secrets and mounts anyway. A create of another config is
        not admitted and does not wait, so a stuck create never holds it.

        Args:
            workspace_id (str): the id being created.
            config_digest (str): the fingerprint of the config it is
                created from.

        Yields:
            bool: True when this create holds the id; False when another
                config's create is building it.
        """
        # A stopped workspace being deleted takes no build under its id.
        if self.forgetting(workspace_id):
            yield False
            return
        while (pending := self._creates.get(workspace_id)) is not None:
            digest, building = pending
            if digest != config_digest:
                yield False
                return
            await asyncio.wait({building})
        done = asyncio.get_running_loop().create_future()
        self._creates[workspace_id] = (config_digest, done)
        try:
            yield True
        finally:
            del self._creates[workspace_id]
            done.set_result(None)

    @property
    def draining(self) -> bool:
        """Whether the server is shutting down: no workspace is built and
        no line starts after it, and readiness answers that it is going.
        The flag lives on the job table, which every door that starts a
        line holds."""
        return self.jobs.draining

    @draining.setter
    def draining(self, value: bool) -> None:
        self.jobs.draining = value

    def has_room(self, own: bool = True) -> bool:
        """Whether a workspace fits under ``max_workspaces``, counting
        those registered and every build in flight, so builds racing each
        other cannot pass it. A build that registered and still answers
        its request counts once.

        Args:
            own (bool): the caller's own build is among those in flight;
                False asks whether one more would fit, as readiness does.
        """
        return (
            self.max_workspaces is None
            or len(self._entries.keys() | self._creates.keys()) + (not own)
            <= self.max_workspaces
        )

    async def drain(self, seconds: float) -> None:
        """Stop building workspaces and let running lines end.

        Each workspace holds new lines while its running ones finish, up
        to ``seconds``; the lines still running then are cancelled. The
        workspaces stay registered for ``close_all`` to stop.

        Args:
            seconds (float): how long running lines get to finish.
        """
        self.draining = True
        await asyncio.gather(
            *(
                _settle(entry, seconds)
                for entry in list(self._entries.values())
            )
        )

    def removing(self, workspace_id: str) -> bool:
        """Whether ``workspace_id`` is being deleted or stopped.

        Args:
            workspace_id (str): id to check.

        Returns:
            bool: True while a ``remove`` or ``stop`` of it is in flight.
        """
        return workspace_id in self._removals

    def forgetting(self, workspace_id: str) -> bool:
        """Whether stopped ``workspace_id`` is being deleted.

        Args:
            workspace_id (str): id to check.
        """
        return workspace_id in self._forgets

    def get(self, workspace_id: str) -> WorkspaceEntry:
        if workspace_id not in self._entries:
            raise KeyError(workspace_id)
        return self._entries[workspace_id]

    def list(self) -> list[WorkspaceEntry]:
        return list(self._entries.values())

    def items(self) -> Iterable[tuple[str, WorkspaceEntry]]:
        return self._entries.items()

    def visible(
        self, workspace_id: str, account: str | None
    ) -> WorkspaceEntry | None:
        """The live entry ``account`` may use, else None.

        The one access rule every entry point asks. A caller with no account
        may use every workspace unless accounts are required; an
        account may use only the workspaces it owns, so one created by
        a caller with no account is closed to every account. A
        workspace that exists but belongs to another account answers
        None like a missing one, so its id does not leak.

        Args:
            workspace_id (str): the workspace asked for.
            account (str | None): the caller's account.
        """
        entry = self._entries.get(workspace_id)
        if entry is None:
            return None
        if account is None:
            return None if self.accounts_required else entry
        return entry if entry.owner == account else None

    async def allows(
        self, workspace_id: str, account: str | None, at: float
    ) -> bool:
        """Whether ``account`` may reach a record ``workspace_id`` made.

        The same rule as ``visible``, for an id that may not be live:
        a stopped workspace's jobs, or a stored workspace after a
        restart, answer to the owner its claim names. A live workspace
        answers only for records made since it was created, so a
        workspace created again under a deleted one's id never reaches
        what the deleted one left.

        Args:
            workspace_id (str): the workspace the record belongs to.
            account (str | None): the caller's account.
            at (float): when the record was made.
        """
        if account is None:
            return not self.accounts_required
        if workspace_id in self._entries:
            entry = self.visible(workspace_id, account)
            return entry is not None and at >= entry.created_at
        if self._owners is None:
            return False
        stored, _ = await self._owners.get(workspace_id)
        return stored is not None and stored.get("account") == account

    async def claim(
        self, workspace_id: str, account: str | None, stored: bool
    ) -> Claim:
        """Record ``account`` as the owner of ``workspace_id``.

        The claim outlives the daemon, so after a restart the stored
        workspace under that id reopens only for the same account. A
        caller with no account claims nothing. An id with stored state
        and no owner (written before accounts were required) is no
        account's to take.

        Args:
            workspace_id (str): the id being created.
            account (str | None): the creating caller's account.
            stored (bool): whether the id already has stored state.

        Returns:
            Claim: NEW when this call recorded the owner, HELD when the
                account already owned the id (or none is recorded), TAKEN
                when it is not the account's to create.
        """
        if account is None or self._owners is None:
            return Claim.HELD
        record, _ = await self._owners.get(workspace_id)
        if record is None and not stored:
            claimed = {"account": account, "generation": 1}
            if await self._owners.cas_put(workspace_id, claimed, 0):
                return Claim.NEW
            record, _ = await self._owners.get(workspace_id)
        if record is not None and record.get("account") == account:
            return Claim.HELD
        return Claim.TAKEN

    async def save_config(
        self, workspace_id: str, config: dict[str, JsonValue]
    ) -> None:
        """Keep the config ``workspace_id`` is built from, as written, so
        ``start`` can build it again once it is stopped.

        Args:
            workspace_id (str): the workspace.
            config (dict[str, JsonValue]): the config as the caller wrote
                it, its pointers unresolved.
        """
        if self._configs is not None:
            await self._configs.put(workspace_id, {"config": config})

    async def drop_config(self, workspace_id: str) -> None:
        """Forget the config kept for ``workspace_id``, as a clone or load
        under the id does: it was built from no config, so ``start`` must
        not build an earlier one's.

        Args:
            workspace_id (str): the workspace.
        """
        if self._configs is not None:
            await self._configs.delete([workspace_id])

    async def saved_config(
        self, workspace_id: str, account: str | None
    ) -> dict[str, JsonValue] | None:
        """The config a stopped ``workspace_id`` starts from, as written,
        when ``account`` may start it; None otherwise.

        Args:
            workspace_id (str): the stopped workspace.
            account (str | None): the caller's account.
        """
        if self._configs is None or not await self.allows(
            workspace_id, account, 0.0
        ):
            return None
        record, _ = await self._configs.get(workspace_id)
        return None if record is None else record["config"]

    async def stopped_ids(self, account: str | None) -> Sequence[str]:
        """The ids of the stopped workspaces ``account`` may use, in
        order: those whose config is kept and that are not live. A
        workspace that is stopping is among them.

        Args:
            account (str | None): the caller's account.
        """
        if self._configs is None:
            return []
        return [
            wid
            for wid in sorted(await self._configs.list_names())
            if wid not in self._entries
            and await self.allows(wid, account, 0.0)
        ]

    async def forget(
        self,
        workspace_id: str,
        account: str | None,
        config: dict[str, JsonValue] | None,
        store: WorkspaceStateStore,
    ) -> Forget:
        """Delete stopped ``workspace_id``: drop its state from ``store``,
        and its config, owner and jobs, as ``remove`` does a live one's.

        The id is reserved first, then checked again: ``account`` may
        still reach it and its saved config is still ``config``, so a
        delete that waited cannot drop a workspace created under the id
        meanwhile. A lease another server holds in a shared store means
        that server runs it, so its state stays.

        Args:
            workspace_id (str): the stopped workspace.
            account (str | None): the caller's account.
            config (dict[str, JsonValue] | None): the config the caller
                found saved.
            store (WorkspaceStateStore): where its state is kept.

        Returns:
            Forget: ``DONE`` once dropped; ``BUSY`` while it is live,
                being built, stopped or deleted here; ``GONE`` when it is
                no longer the one the caller found; ``HELD`` while
                another server holds its lease.
        """
        if (
            workspace_id in self._entries
            or workspace_id in self._creates
            or self.removing(workspace_id)
            or self.forgetting(workspace_id)
        ):
            return Forget.BUSY
        self._forgets.add(workspace_id)
        try:
            if (
                not await self.allows(workspace_id, account, 0.0)
                or await self.saved_config(workspace_id, account) != config
            ):
                return Forget.GONE
            if await store.execution(workspace_id).holder() is not None:
                return Forget.HELD
            try:
                await store.drop(workspace_id)
                if self._configs is not None:
                    await self._configs.delete([workspace_id])
                if self._owners is not None:
                    await self._owners.delete([workspace_id])
            finally:
                self.jobs.discard_workspace(workspace_id)
        finally:
            self._forgets.discard(workspace_id)
        return Forget.DONE

    async def release(self, workspace_id: str) -> None:
        """Drop the owner a failed create recorded, freeing the id.

        Args:
            workspace_id (str): the id whose claim is released.
        """
        if self._owners is not None:
            await self._owners.delete([workspace_id])

    @asynccontextmanager
    async def restoring(self) -> AsyncIterator[Sequence[Policy]]:
        """The server's policies, for a snapshot restore to meet as it
        reads the snapshot's saved values, as a live write meets them.
        The programs' runner is the restore's own, closed as it ends,
        since its runtimes start on the request's loop; ``add`` takes
        the list back as ``restored_with``.
        """
        programs = (
            ScriptPolicy(_Programs(self._programs)) if self._programs else None
        )
        try:
            yield [*self.policies, *([programs] if programs else [])]
        finally:
            if programs is not None:
                await programs.close()

    def add(
        self,
        workspace: Workspace | WorkspaceRunner,
        workspace_id: str | None = None,
        owner: str | None = None,
        restored_with: Sequence[Policy] = (),
    ) -> WorkspaceEntry:
        """Wrap ``workspace`` in a runner and register it.

        Args:
            workspace (Workspace | WorkspaceRunner): a freshly built
                workspace, or a runner that built one on its own loop.
            workspace_id (str | None): explicit id, or None to auto-mint.
            owner (str | None): the creating caller's account.
            restored_with (Sequence[Policy]): the policies ``restoring``
                gave the restore that built it, taken off before the
                server's own are attached.

        Returns:
            WorkspaceEntry: the registered entry.

        Raises:
            ValueError: ``workspace_id`` is already registered, or still
                being deleted or stopped.
        """
        if isinstance(workspace, WorkspaceRunner):
            runner: WorkspaceRunner | None = workspace
            ws = workspace.ws
        else:
            runner, ws = None, workspace
        wid = workspace_id or new_workspace_id()
        if wid in self._entries or self.removing(wid) or self.forgetting(wid):
            raise ValueError(f"workspace id already exists: {wid!r}")
        for policy in restored_with:
            ws.policies.remove(policy)
        for policy in self.policies:
            ws.policies.add(policy)
        ws.registry.network = self.rule_for(ws.network)
        # An account reaches only the workspaces it owns, so every
        # method's caller is the owner's account.
        ws.policies.account = owner
        if runner is None:
            runner = WorkspaceRunner(ws)
        entry = WorkspaceEntry(wid, runner, owner)
        if self._programs:
            entry.programs = ScriptPolicy(_Programs(self._programs))
            ws.policies.add(entry.programs)
        self._entries[wid] = entry
        self._cancel_idle_timer()
        return entry

    async def remove(self, workspace_id: str) -> WorkspaceEntry:
        """Delete ``workspace_id``: stop its runner and drop its state.

        The workspace's links, history, sessions, metadata, jobs and owner
        leave with it, so a workspace created later under the same id
        starts empty, for any account. ``close_all`` (daemon shutdown)
        keeps them. The id stays registered until the deletion is done, so
        a create under it is refused rather than registering a workspace
        whose state this deletion would then remove. An overlapping remove
        of the same id joins the deletion in flight, so it never
        unregisters a workspace created after it.

        Args:
            workspace_id (str): id to remove.

        Returns:
            WorkspaceEntry: the removed entry (after its runner is
                stopped).

        Raises:
            KeyError: ``workspace_id`` is not registered.
        """
        removal = self._removals.get(workspace_id)
        if removal is None:
            if workspace_id not in self._entries:
                raise KeyError(workspace_id)
            self._entries[workspace_id].accepting_jobs = False
            removal = asyncio.create_task(
                self._remove(self._entries[workspace_id])
            )
            self._removals[workspace_id] = removal
        return await asyncio.shield(removal)

    async def _remove(self, entry: WorkspaceEntry) -> WorkspaceEntry:
        """Run one deletion, releasing the id once it is done.

        Args:
            entry (WorkspaceEntry): the entry being deleted.
        """
        try:
            await _stop(entry, self.jobs, delete=True)
            if self._owners is not None:
                await self._owners.delete([entry.id])
            if self._configs is not None:
                await self._configs.delete([entry.id])
        finally:
            self.jobs.discard_workspace(entry.id)
            del self._removals[entry.id]
            self._entries.pop(entry.id, None)
            if not self._entries:
                self._start_idle_timer()
        return entry

    async def stop(self, workspace_id: str) -> WorkspaceEntry:
        """Stop ``workspace_id`` and keep its state.

        The runner stops, which cancels its lines and closes its
        sessions; the stored sessions, links, history, owner and config
        stay, so the owner starting the same id later picks them up. No
        new request reaches the stopping runner, and the id stays
        reserved until it has stopped, so a start never loads state the
        old runner is still writing.

        Args:
            workspace_id (str): id to stop.

        Returns:
            WorkspaceEntry: the stopped entry.

        Raises:
            KeyError: ``workspace_id`` is not registered.
        """
        removal = self._removals.get(workspace_id)
        if removal is None:
            entry = self._entries.pop(workspace_id)
            entry.accepting_jobs = False
            removal = asyncio.create_task(self._stop_kept(entry))
            self._removals[workspace_id] = removal
        return await asyncio.shield(removal)

    async def _stop_kept(self, entry: WorkspaceEntry) -> WorkspaceEntry:
        """Run one stop, releasing the id once the runner has stopped.

        Args:
            entry (WorkspaceEntry): the entry being stopped.
        """
        try:
            await _stop(entry, self.jobs)
        finally:
            del self._removals[entry.id]
            if not self._entries:
                self._start_idle_timer()
        return entry

    async def close_all(self) -> None:
        """Stop every runner. Used at daemon shutdown."""
        self._cancel_idle_timer()
        ids = list(self._entries)
        for wid in ids:
            entry = self._entries.pop(wid)
            entry.accepting_jobs = False
            try:
                await _stop(entry, self.jobs)
            except Exception:
                logger.exception("error stopping runner for %s", wid)
        await self._admission_programs.close()

    def _start_idle_timer(self) -> None:
        if self.idle_grace_seconds <= 0:
            self.exit_event.set()
            return
        if self._idle_task is not None and not self._idle_task.done():
            return
        self._idle_task = asyncio.create_task(self._idle_wait())

    def _cancel_idle_timer(self) -> None:
        if self._idle_task is not None and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = None

    async def _idle_wait(self) -> None:
        try:
            await asyncio.sleep(self.idle_grace_seconds)
        except asyncio.CancelledError:
            return
        if not self._entries:
            self.exit_event.set()


def _workspace_context(
    config: dict[str, JsonValue], account: str | None
) -> WorkspaceContext:
    """A workspace about to be built, as pre_workspace methods read it.

    Args:
        config (dict[str, JsonValue]): the config as the caller wrote it.
        account (str | None): the account the request signed in as.
    """
    return WorkspaceContext(config, PolicyCaller(account=account))


async def _settle(entry: WorkspaceEntry, seconds: float) -> None:
    """Let an entry's running lines end within ``seconds``, holding new
    ones meanwhile, and cancel those still running then.

    Args:
        entry (WorkspaceEntry): the entry.
        seconds (float): how long its lines get.
    """
    ws = entry.runner.ws

    # The deadline starts before a capture already under way is waited
    # for, so a snapshot holding the workspace cannot stretch it.
    async def settle() -> None:
        try:
            async with asyncio.timeout(seconds):
                async with ws._quiesced(seconds):
                    return
        except TimeoutError as exc:
            logger.debug(
                "drain: %s still busy at the deadline: %r", entry.id, exc
            )
        except OSError as exc:
            if exc.errno != errno.EBUSY:
                raise
            logger.debug("drain: cancelling %s's lines: %s", entry.id, exc)
        await ws.cancel()

    try:
        await entry.runner.call(settle())
    except RuntimeError:
        logger.debug("drain: %s already stopped", entry.id)


async def _stop(
    entry: WorkspaceEntry, jobs: RequestTable, delete: bool = False
) -> None:
    """Stop an entry's runner, closing on the workspace's loop, before
    the loop goes, the runtimes its server policy programs ran on and the
    stdins its lines hold open, which answers a write waiting on one.

    Args:
        entry (WorkspaceEntry): the entry.
        jobs (RequestTable): the requests that run lines.
        delete (bool): delete the workspace's state as it closes.
    """

    async def close_stdins() -> None:
        for request in jobs.requests():
            if request.workspace_id == entry.id and request.stdin is not None:
                request.stdin.close_reader()

    try:
        await entry.runner.call(close_stdins())
    except RuntimeError as exc:
        logger.debug("%s already stopped: %s", entry.id, exc)
    if entry.programs is not None:
        try:
            await entry.runner.call(entry.programs.close())
        except Exception:
            logger.exception("closing %s's policy programs", entry.id)
    await entry.runner.stop(delete=delete)
