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
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn
from mirage.types import MountMode
from mirage.utils.context_scope import ContextScope
from mirage.utils.hidden import is_glob, show_head
from mirage.workspace.files import Files
from mirage.workspace.session import SessionState


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    """Local workspace binding captured for one execution, never guest globals.

    The scoped entry points retain session, policy, and observation context
    even when called later from a worker callback. No workspace stores are
    exposed. ``ctx`` is the same ``Context`` a command or CLI gets: its
    ``vfs`` is the session's files, whose links a guest's path resolves
    through, None outside a workspace.
    """

    binding: WorkspaceBinding
    dispatch: DispatchFn
    resolver: MountResolver
    scope: ContextScope
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
        restricted_mounts (tuple[str, ...] | None): the mounts the
            session restricts.
    """
    scope = ContextScope()
    ctx = ctx if ctx is not None else Context()
    session = ctx.session
    if session is not None:
        ctx = replace(
            ctx,
            session=replace(
                session,
                get=scope.wrap(session.get),
                snapshot=scope.wrap(session.snapshot),
                set=scope.wrap_async(session.set),
                unset=scope.wrap_async(session.unset),
                mark=scope.wrap_async(session.mark),
                is_readonly=scope.wrap(session.is_readonly),
                profile=scope.wrap(session.profile),
                cwd=scope.wrap(session.cwd),
            ),
        )
    resolver = ScopedResolver(binding.resolver, scope)
    return RuntimeContext(
        binding=binding,
        dispatch=scope.wrap_async(binding.dispatch),
        resolver=resolver,
        scope=scope,
        ctx=ctx,
        restricted_mounts=restricted_mounts or (),
    )


class ScopedResolver:
    """Delegate every routing question under the captured context."""

    def __init__(self, resolver: MountResolver, scope: ContextScope) -> None:
        self._resolver = resolver
        self._scope = scope

    def prefixes(self) -> list[str]:
        return self._scope.call(self._resolver.prefixes)

    def owner_of(self, path: str) -> str | None:
        return self._scope.call(self._resolver.owner_of, path)

    def link_children(self, directory: str) -> set[str]:
        return self._scope.call(self._resolver.link_children, directory)
