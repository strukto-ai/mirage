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
from collections.abc import Awaitable, Callable
from typing import Literal

from mirage.cache.index import NULL_INDEX
from mirage.context import (
    reset_current_session,
    set_current_session,
)
from mirage.errors.fs import eexist, enoent, enotdir
from mirage.policy.profile import CompiledProfile
from mirage.types import FileType, MountMode, PathSpec, ReadSpec
from mirage.utils.hidden import path_visible
from mirage.utils.path import norm, parent
from mirage.vfs.document.document import DocumentVFS
from mirage.workspace.documentation import render
from mirage.workspace.files import Files
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.resolve import apply_profile
from mirage.workspace.session.session import SessionState


class Documents:
    """Session-aware generated files owned by one live workspace.

    Args:
        registry (MountRegistry): the workspace's mounts.
        ops (Files): the workspace's op facade.
        manager (SessionManager): the workspace's sessions.
        session (Callable[[], SessionState]): the session a call runs as.
        profile (Callable[[str], CompiledProfile]): a named profile,
            compiled.
        ensure_loaded (Callable[[], Awaitable[None]]): hydrates the
            sessions.
        unmount (Callable[[str], Awaitable[None]]): removes a mount.
        follow_parent (Callable[[str], str]): a path with every link
            above its name followed.
    """

    def __init__(
        self,
        registry: MountRegistry,
        ops: Files,
        manager: SessionManager,
        session: Callable[[], SessionState],
        profile: Callable[[str], CompiledProfile],
        ensure_loaded: Callable[[], Awaitable[None]],
        unmount: Callable[[str], Awaitable[None]],
        follow_parent: Callable[[str], str],
    ) -> None:
        self.views: dict[str, DocumentVFS] = {}
        self.lock = asyncio.Lock()
        self._registry = registry
        self._ops = ops
        self._manager = manager
        self._session = session
        self._profile = profile
        self._ensure_loaded = ensure_loaded
        self._unmount = unmount
        self._follow_parent = follow_parent

    def render(self, kind: Literal["vfs", "skill"]) -> str:
        renderer = render.vfs_md if kind == "vfs" else render.skill_md
        return renderer(self._registry, self._session())

    async def clear(self) -> None:
        """Drop every binding; a snapshot load restores none."""
        async with self.lock:
            for path in list(self.views):
                await self._unmount(path)

    async def release_session(self, session_id: str) -> None:
        async with self.lock:
            for path, view in list(self.views.items()):
                view.sessions.pop(session_id, None)
                if not view.global_view and not view.sessions:
                    await self._unmount(path)

    async def get(
        self,
        kind: Literal["vfs", "skill"],
        path: str | PathSpec | None,
        profile: str | None,
        session_id: str | None,
    ) -> str:
        if profile is not None and (
            path is not None or session_id is not None
        ):
            raise ValueError(
                "profile is only valid for generation without a path or session"
            )
        await self._ensure_loaded()
        if profile is not None:
            session = SessionState(session_id="")
            apply_profile(session, self._profile(profile))
        else:
            session = (
                self._manager.get(session_id)
                if session_id is not None
                else self._session()
            )
        token = set_current_session(session, self._manager)
        try:
            if path is not None:
                virtual = path.virtual if isinstance(path, PathSpec) else path
                if (
                    norm(virtual) != virtual
                    or "\x00" in virtual
                    or any(
                        part in {"", ".", ".."}
                        for part in virtual.split("/")[1:]
                    )
                ):
                    raise ValueError(
                        "document path must be an absolute, normalized file path"
                    )
                # Bound where a later read lands: every link above the
                # name is followed, as the read's own walk follows it.
                bound = self._follow_parent(virtual)
                if not all(
                    path_visible(session.visibility, p)
                    for p in (virtual, bound)
                ):
                    raise enoent(virtual)
                async with self.lock:
                    await self.expose(
                        kind,
                        bound,
                        session if session_id is not None else None,
                    )
            return self.render(kind)
        finally:
            reset_current_session(token)

    async def expose(
        self,
        kind: Literal["vfs", "skill"],
        path: str,
        session: SessionState | None,
    ) -> None:
        directory = await self._ops.stat(parent(path))
        if directory.type != FileType.DIRECTORY:
            raise enotdir(parent(path))
        view = self.views.get(path)
        if view is not None and view.kind != kind:
            raise eexist(path)
        if view is None:
            # Collision checks are host-side: a hidden backend entry must
            # not be overwritten by a new view either.
            token = set_current_session(
                SessionState(session_id=""), self._manager
            )
            try:
                try:
                    await self._ops.stat(path, nofollow=True)
                except FileNotFoundError:
                    pass
                else:
                    raise eexist(path)
            finally:
                reset_current_session(token)
            view = DocumentVFS(
                path.rsplit("/", 1)[-1], lambda: self.render(kind), kind
            )
            mount = self._registry.mount(
                path, view, MountMode.READ, ReadSpec(), store=NULL_INDEX
            )
            mount.visible = lambda: (
                view.global_view
                or view.sessions.get(self._session().session_id)
                == self._session().created_at
            )
            self.views[path] = view
            self._ops.set_mounts(self._registry.mount_rows())
        if session is None:
            view.global_view = True
        else:
            view.sessions[session.session_id] = session.created_at
