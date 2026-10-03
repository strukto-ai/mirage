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
from typing import TYPE_CHECKING, Literal

from mirage.cache.index import NULL_INDEX
from mirage.context import (
    get_current_session_unless_foreign,
    path_allowed,
    reset_current_session,
    set_current_session,
)
from mirage.types import FileType, MountMode, PathSpec, ReadSpec
from mirage.utils.errors import eexist, enoent, enotdir
from mirage.utils.path import norm, parent
from mirage.vfs.document.document import DocumentVFS
from mirage.workspace.documentation import render
from mirage.workspace.session.resolve import apply_profile, compile_profile
from mirage.workspace.session.session import SessionState

if TYPE_CHECKING:
    from mirage.workspace.workspace.workspace import Workspace


class Documents:
    """Session-aware generated files owned by one live workspace."""

    def __init__(self, workspace: "Workspace") -> None:
        self.workspace = workspace
        self.views: dict[str, DocumentVFS] = {}
        self.lock = asyncio.Lock()

    def session(self) -> SessionState:
        ws = self.workspace
        return (
            get_current_session_unless_foreign(ws._session_mgr)
            or ws._op_session()
        )

    def render(self, kind: Literal["vfs", "skill"]) -> str:
        ws = self.workspace
        renderer = render.vfs_md if kind == "vfs" else render.skill_md
        return renderer(ws._registry, self.session())

    async def release_session(self, session_id: str) -> None:
        async with self.lock:
            for path, view in list(self.views.items()):
                view.sessions = {
                    s for s in view.sessions if s[0] != session_id
                }
                if not view.global_view and not view.sessions:
                    await self.workspace.unmount(path)

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
        ws = self.workspace
        await ws.ensure_sessions_loaded()
        if profile is not None:
            session = SessionState(session_id="")
            apply_profile(
                session, compile_profile(ws._base_profile(profile), profile)
            )
        else:
            session = (
                ws.get_session(session_id)
                if session_id is not None
                else self.session()
            )
        token = set_current_session(session, ws._session_mgr)
        try:
            if path is not None:
                virtual = path.virtual if isinstance(path, PathSpec) else path
                if (
                    not virtual.startswith("/")
                    or virtual.endswith("/")
                    or norm(virtual) != virtual
                    or any(
                        part in {"", ".", ".."}
                        for part in virtual.split("/")[1:]
                    )
                    or "\x00" in virtual
                ):
                    raise ValueError(
                        "document path must be an absolute, normalized file path"
                    )
                if not path_allowed(virtual):
                    raise enoent(virtual)
                async with self.lock:
                    await self.expose(
                        kind,
                        virtual,
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
        ws = self.workspace
        directory = await ws.vfs.stat(parent(path))
        if directory.type != FileType.DIRECTORY:
            raise enotdir(parent(path))
        view = self.views.get(path)
        if view is not None:
            if view.kind != kind:
                raise eexist(path)
        else:
            # Collision checks are host-side: a hidden backend entry must
            # not be overwritten by a new view either.
            token = set_current_session(
                SessionState(session_id=""), ws._session_mgr
            )
            try:
                try:
                    await ws.vfs.stat(path, nofollow=True)
                except FileNotFoundError:
                    pass
                else:
                    raise eexist(path)
            finally:
                reset_current_session(token)
            view = DocumentVFS(
                path.rsplit("/", 1)[-1], lambda: self.render(kind), kind
            )
            mount = ws._registry.mount(
                path, view, MountMode.READ, ReadSpec(), store=NULL_INDEX
            )
            mount.visible = lambda: (
                view.global_view
                or (self.session().session_id, self.session().created_at)
                in view.sessions
            )
            self.views[path] = view
            ws._ops.set_mounts(ws._registry.ops_mounts())
        if session is None:
            view.global_view = True
        else:
            view.sessions.add((session.session_id, session.created_at))
