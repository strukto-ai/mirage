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

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from types import MappingProxyType

from mirage.doors.types import NamespaceView, SessionView
from mirage.process.view import ProcessView
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.context_scope import ContextScope


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    """Local workspace binding captured for one execution, never guest globals.

    The scoped doors retain session, policy, and observation context even
    when called later from a worker callback. No workspace stores are exposed.
    """

    binding: WorkspaceBinding
    dispatch: DispatchFn
    resolver: MountResolver
    ns: NamespaceView
    session_view: SessionView | None
    cwd: PathSpec
    env: Mapping[str, str]
    scope: ContextScope
    processes: ProcessView | None = None


class WorkspaceBinding:
    """Local workspace connection shared by execution and filesystem adapters.

    Dispatch and routing stay live. Capture constructs per-execution views;
    holding the binding never holds a mutable current-session slot.
    """

    def __init__(
        self,
        dispatch: DispatchFn,
        resolver: MountResolver,
        context: Callable[[WorkspaceBinding], RuntimeContext] | None = None,
    ) -> None:
        self.dispatch = dispatch
        self.resolver = resolver
        self._context = context

    def capture(self) -> RuntimeContext:
        return (
            self._context(self)
            if self._context is not None
            else capture_binding(self)
        )


def capture_binding(
    binding: WorkspaceBinding,
    *,
    ns: NamespaceView | None = None,
    session_view: SessionView | None = None,
    processes: ProcessView | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
) -> RuntimeContext:
    """Capture callback context while reading live workspace state."""
    scope = ContextScope()
    view = ns or NamespaceView()
    links = view.links
    if links is not None:
        links = replace(
            links,
            stat_at=scope.wrap(links.stat_at),
            children=scope.wrap(links.children),
            subtree=scope.wrap(links.subtree),
            resolve=scope.wrap(links.resolve),
            exists=scope.wrap_async(links.exists),
            target_stat=scope.wrap_async(links.target_stat),
        )
    mounts = view.mounts
    if mounts is not None:
        mounts = replace(
            mounts,
            descendants=scope.wrap(mounts.descendants),
            visible_descendants=scope.wrap(mounts.visible_descendants),
            is_root=scope.wrap(mounts.is_root),
            root_of=scope.wrap(mounts.root_of),
            max_du_entries=(
                scope.wrap(mounts.max_du_entries)
                if mounts.max_du_entries is not None
                else None
            ),
        )
    view = replace(
        view,
        links=links,
        mounts=mounts,
        stat_overlay=scope.wrap(view.stat_overlay)
        if view.stat_overlay
        else None,
        child_mounts=scope.wrap(view.child_mounts)
        if view.child_mounts
        else None,
    )
    if session_view is not None:
        session_view = replace(
            session_view,
            get=scope.wrap(session_view.get),
            snapshot=scope.wrap(session_view.snapshot),
            set=scope.wrap_async(session_view.set),
            unset=scope.wrap_async(session_view.unset),
            mark=scope.wrap_async(session_view.mark),
            is_readonly=scope.wrap(session_view.is_readonly),
            profile=scope.wrap(session_view.profile),
        )
    resolver = ScopedResolver(binding.resolver, scope)
    return RuntimeContext(
        binding=binding,
        dispatch=scope.wrap_async(binding.dispatch),
        resolver=resolver,
        ns=view,
        session_view=session_view,
        cwd=cwd or PathSpec.from_str_path("/"),
        env=MappingProxyType(dict(env or {})),
        scope=scope,
        processes=processes,
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
