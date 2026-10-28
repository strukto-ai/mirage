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

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace

from mirage.commands.config import Context
from mirage.context.session_context import (
    Caller,
    awaits_as,
    calls_as,
    current_caller,
    note_refusal,
)
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn, RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.types import MountMode, Refusal
from mirage.utils.hidden import is_glob, show_head
from mirage.workspace.files import Files
from mirage.workspace.session import SessionState


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    """Local workspace binding captured for one execution, never guest globals.

    The entry points run as ``caller``, the caller the execution was
    captured under (its session, policies, recorder and execution), even
    when a guest calls them later from a thread of its own. No workspace
    stores are exposed. ``ctx`` is the same ``Context`` a command or CLI
    gets: its ``vfs`` is the session's files over the binding's dispatch,
    so a guest's calls are the program's own, and its links are the ones
    a guest's path resolves through. ``Runtime.execute`` runs as
    ``caller`` and hands the run this ``vfs`` and ``session``.
    """

    caller: Caller
    ctx: Context
    restricted_mounts: tuple[str, ...] = ()


class WorkspaceBinding:
    """Local workspace connection shared by execution and filesystem adapters.

    Dispatch and routing stay live. Capture constructs per-execution views;
    holding the binding never holds a mutable current-session slot.
    ``files`` is the workspace's ``ws.vfs``, ``get_session`` its live
    session by id and ``mount_prefixes`` every prefix a sandbox may be
    told of, whatever the session hides, for an adapter that serves the
    mounts as files (a sandbox's SFTP); each is None outside a workspace.
    """

    def __init__(
        self,
        dispatch: DispatchFn,
        resolver: MountResolver,
        context: Callable[[WorkspaceBinding], RuntimeContext] | None = None,
        files: Files | None = None,
        get_session: Callable[[str], SessionState] | None = None,
        mount_prefixes: Callable[[], list[str]] | None = None,
    ) -> None:
        self.dispatch = dispatch
        self.resolver = resolver
        self._context = context
        self.files = files
        self.get_session = get_session
        self.mount_prefixes = mount_prefixes

    def capture(self) -> RuntimeContext:
        return (
            self._context(self)
            if self._context is not None
            else capture_binding(self)
        )


def refused_run(name: str, reason: str) -> RunResult:
    """A run the session's restrictions refuse before it starts, as
    admission refuses a command: bash's ``<name>: Permission denied`` at
    126, the reason on the line's refusal record and never on stderr.

    Args:
        name (str): the runtime, which names the refusal.
        reason (str): why, for the record.
    """
    note_refusal(Refusal(kind="deny", reason=reason))
    return RunResult(
        stdout=b"",
        stderr=f"{name}: Permission denied\n".encode(),
        exit_code=CANNOT_EXECUTE_STATUS,
    )


def restricted_mounts_for(
    session: SessionState, prefixes: list[str]
) -> tuple[str, ...]:
    """Map file restrictions to their owning mounts, excluding ancestor mounts.

    Args:
        session (SessionState): the execution's session.
        prefixes (list[str]): every workspace mount, including hidden mounts.
    """
    entries: list[str] = []
    hidden = session.visibility.paths
    if hidden is not None:
        entries.extend((*hidden.paths, *hidden.patterns))
    shown = session.visibility.shown
    if shown is not None:
        entries.extend(
            e.path
            for e in shown.entries
            if e.mode is not None and e.mode is not MountMode.EXEC
        )
    if session.commands is not None:
        for rule in (*session.commands.ask, *session.commands.deny):
            entries.extend(rule.paths or ((rule.mount,) if rule.mount else ()))
    entries.extend(
        p
        for p, mode in (session.mount_modes or {}).items()
        if mode is not MountMode.EXEC
    )
    mounts = {p.rstrip("/") or "/": p for p in prefixes}
    mounts.setdefault("/", "/")
    restricted: set[str] = set()
    for entry in entries:
        head = "/" if is_glob(entry) and "/" not in entry else show_head(entry)
        owners = [
            p
            for p in mounts
            if p == "/" or head == p or head.startswith(p + "/")
        ]
        restricted.add(mounts[max(owners, key=len)])
        restricted.update(
            value
            for p, value in mounts.items()
            if head == "/" or p.startswith(head + "/")
        )
    return tuple(sorted(restricted))


def capture_binding(
    binding: WorkspaceBinding,
    *,
    ctx: Context | None = None,
    restricted_mounts: tuple[str, ...] | None = None,
) -> RuntimeContext:
    """Capture callback context while reading live workspace state.

    Args:
        binding (WorkspaceBinding): the workspace connection.
        ctx (Context | None): the session's files, session, processes,
            cwd and env, as a command gets them; None outside a session.
            The files are rebuilt over the binding's dispatch.
        restricted_mounts (tuple[str, ...] | None): the mounts the
            session restricts.
    """
    caller = current_caller()
    ctx = ctx if ctx is not None else Context()
    dispatch = awaits_as(caller, binding.dispatch)
    ctx = replace(
        ctx,
        vfs=(
            ctx.vfs._over(dispatch)
            if ctx.vfs is not None
            else Files(dispatch, ledger=False)
        ),
    )
    # A read of the session reads the session it is bound to; only a
    # write passes the gates, which read the caller, so only a write
    # runs as it.
    session = ctx.session
    if session is not None:
        ctx = replace(
            ctx,
            session=replace(
                session,
                set=awaits_as(caller, session.set),
                unset=awaits_as(caller, session.unset),
                mark=awaits_as(caller, session.mark),
            ),
        )
    return RuntimeContext(
        caller=caller,
        ctx=ctx,
        restricted_mounts=restricted_mounts or (),
    )


class CallerResolver:
    """Ask every routing question as the captured caller, whose session
    decides which mounts it is told of."""

    def __init__(self, resolver: MountResolver, caller: Caller) -> None:
        self._prefixes = calls_as(caller, resolver.prefixes)
        self._owner_of = calls_as(caller, resolver.owner_of)
        self._link_children = calls_as(caller, resolver.link_children)

    def prefixes(self) -> list[str]:
        return self._prefixes()

    def owner_of(self, path: str) -> str | None:
        return self._owner_of(path)

    def link_children(self, directory: str) -> set[str]:
        return self._link_children(directory)
