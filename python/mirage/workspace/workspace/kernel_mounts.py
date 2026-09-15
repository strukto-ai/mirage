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

import logging
import sys

from mirage.mount.backend import (KernelRoute, require_kernel_backend,
                                  resolve_backend, route_of)
from mirage.nfs.config import NFSConfig
from mirage.ops import Ops
from mirage.types import MountBackend
from mirage.workspace.fuse import FuseManager
from mirage.workspace.nfs import NFSManager
from mirage.workspace.session import SessionManager

logger = logging.getLogger(__name__)


class KernelMounts:
    """The workspace's real mountpoints, one manager per subtree.

    A ``vfs`` mount lives only inside mirage; a ``fuse``, ``fskit`` or
    ``nfs`` mount also registers a mountpoint with the kernel. This owns
    the set of those: which prefix is exposed where, and the manager
    serving it. Keys are ``prefix`` or ``prefix@session_id``, so the
    same subtree can be exposed both unbound and bound to a session.

    The two tiers differ in when they mount, not in what they expose.
    A FUSE mount runs on a daemon thread, so it comes up inside the
    synchronous constructor; an NFS mount is served by the caller's own
    event loop, so a declared one is recorded here and mounted by the
    first ``ready`` -- which ``execute`` awaits, the way the TypeScript
    workspace awaits ``fuseReady``. One ``NFSManager`` backs every nfs
    prefix, because one server can export any number of them.
    """

    def __init__(self, ops: Ops, sessions: SessionManager) -> None:
        self._ops = ops
        self._sessions = sessions
        self._mountpoints: dict[str, str] = {}
        self._managers: dict[str, FuseManager] = {}
        self._backends: dict[str, MountBackend] = {}
        # One manager per session, keyed by session id (None is the
        # unscoped one). A server serves one delegate, so a scoped mount
        # cannot narrow an existing server -- it needs its own.
        self._nfs: dict[str | None, NFSManager] = {}
        self._deferred: list[tuple[str, str | None, NFSConfig | None]] = []

    def add(self,
            prefix: str,
            mountpoint: str | None = None,
            session_id: str | None = None,
            backend: str | MountBackend = MountBackend.FUSE) -> str:
        """Expose ``prefix`` at a real mountpoint and return its path.

        A session-bound mount runs every op under that session's mount
        grants (the kernel-tier primitive: bind-mount the tree into a
        container and the narrowing travels with it).

        Args:
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a path.
            session_id (str | None): session whose grants scope the ops.
            backend (str | MountBackend): fuse or fskit.

        Raises:
            ValueError: the mountpoint is already serving another prefix.
            RuntimeError: the nfs backend was asked for on this route.
        """
        resolved_backend = resolve_backend(backend)
        route = route_of(resolved_backend)
        if route is KernelRoute.LOOP:
            raise RuntimeError(
                f"the {resolved_backend.value} backend is served by the "
                "caller's event loop, not by a mount thread; use "
                "await ws.add_nfs_mount(prefix)")
        if route is KernelRoute.NONE:
            require_kernel_backend(resolved_backend)
        # Register a pinned path BEFORE mounting so a collision is
        # rejected without leaving a partial mount.
        session = (self._sessions.get(session_id)
                   if session_id is not None else None)
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        if mountpoint is not None:
            self._register(key, mountpoint)
        manager = FuseManager()
        self._managers[key] = manager
        try:
            resolved = manager.setup(self._ops,
                                     prefix,
                                     mountpoint,
                                     session=session,
                                     backend=resolved_backend)
        except Exception:
            # The mount never came up; drop the manager and any
            # registered path so mountpoints does not misreport it.
            self._managers.pop(key, None)
            self._mountpoints.pop(key, None)
            raise
        if mountpoint is None:
            self._register(key, resolved)
        self._backends[key] = resolved_backend
        return resolved

    def defer_nfs(self,
                  prefix: str,
                  mountpoint: str | None = None,
                  config: NFSConfig | None = None) -> None:
        """Record a declared nfs mount for the next ``ready``.

        The constructor that reads a mount spec is synchronous and the
        server needs a running loop, so a declaration is held here
        rather than mounted where it is read.

        Args:
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a path.
            config (NFSConfig | None): server knobs from the
                declaration. One server serves every nfs prefix, so the
                first declaration to carry one fixes them.
        """
        self._deferred.append((prefix, mountpoint, config))

    async def ready(self) -> None:
        """Mount every deferred nfs declaration, once.

        A failure degrades to an unmounted but fully usable workspace,
        the way a FUSE auto-mount failure does: that one runs on a
        daemon thread, so it never reaches the caller either. The
        explicit ``add_nfs`` route raises instead.
        """
        while self._deferred:
            prefix, mountpoint, config = self._deferred.pop(0)
            try:
                await self.add_nfs(prefix, mountpoint, config=config)
            except Exception as exc:
                logger.warning("nfs auto-mount failed for %s: %s", prefix, exc)
                print(
                    f"mirage: nfs auto-mount failed for {prefix}, "
                    f"continuing without it: {exc}",
                    file=sys.stderr)

    async def add_nfs(self,
                      prefix: str,
                      mountpoint: str | None = None,
                      config: NFSConfig | None = None,
                      session_id: str | None = None) -> str:
        """Expose ``prefix`` over nfs and return its mountpoint.

        A session-scoped mount runs every op under that session's mount
        grants, the same narrowing ``add`` gives a fuse mount. It costs
        a second server rather than a second mount, because one server
        serves one delegate; managers are kept per session so a second
        scoped prefix reuses the one its session already has.

        Args:
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a path.
            config (NFSConfig | None): server knobs. One server backs
                every prefix of a session, so the first mount fixes them
                and a later config is ignored.
            session_id (str | None): session whose grants scope the ops.

        Returns:
            str: the mountpoint now serving the prefix.

        Raises:
            ValueError: the mountpoint is already serving another prefix.
            KeyError: no such session.
        """
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        session = (self._sessions.get(session_id)
                   if session_id is not None else None)
        if mountpoint is not None:
            self._register(key, mountpoint)
        manager = self._nfs.get(session_id)
        if manager is None:
            manager = NFSManager()
            self._nfs[session_id] = manager
        try:
            resolved = await manager.setup(self._ops, prefix, mountpoint,
                                           config, session)
        except Exception:
            self._mountpoints.pop(key, None)
            if not manager.mountpoints:
                self._nfs.pop(session_id, None)
            raise
        self._register(key, resolved)
        self._backends[key] = MountBackend.NFS
        return resolved

    def remove(self, prefix: str, session_id: str | None = None) -> None:
        """Unmount one exposed subtree.

        Args:
            prefix (str): the virtual prefix that was exposed.
            session_id (str | None): session the mount was bound to.

        Raises:
            RuntimeError: the prefix is served over nfs, which unmounts
                on the caller's event loop.
        """
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        if self._route_of(key) is KernelRoute.LOOP:
            raise RuntimeError(
                f"prefix {prefix!r} is served over nfs; use await "
                "ws.remove_nfs_mount(prefix)")
        manager = self._managers.pop(key, None)
        if manager is not None:
            manager.unmount()
        self._mountpoints.pop(key, None)
        self._backends.pop(key, None)

    async def remove_nfs(self,
                         prefix: str,
                         session_id: str | None = None) -> None:
        """Unmount one exposed nfs prefix. Missing prefixes no-op.

        A session's server stops with its last mount: it exists to serve
        that session's view, so past the view it is a delegate nothing
        can reach. The unscoped server outlives its mounts on purpose --
        it is the workspace's own, and a remove-then-add cycle should
        not cost a restart.

        Args:
            prefix (str): the virtual prefix that was exposed.
            session_id (str | None): the session it was scoped to.
        """
        manager = self._nfs.get(session_id)
        if manager is None:
            return
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        await manager.unmount(prefix)
        self._mountpoints.pop(key, None)
        self._backends.pop(key, None)
        if session_id is not None and not manager.mountpoints:
            await manager.close()
            self._nfs.pop(session_id, None)

    def close(self) -> None:
        """Unmount everything that needs no event loop.

        The nfs half is ``close_nfs``: unmounting flushes the client's
        dirty pages back through a live server, which needs a loop to
        await. A workspace torn down without one leaves those mounts
        standing, so say so rather than dropping them silently.
        """
        for manager in list(self._managers.values()):
            manager.unmount()
        self._managers.clear()
        live = [
            point for manager in self._nfs.values()
            for point in manager.mountpoints.values()
        ]
        if live:
            logger.warning(
                "nfs mounts still live at close: %s; they are unmounted by "
                "the async close, not this one", sorted(live))
            for key in list(self._mountpoints):
                if self._route_of(key) is not KernelRoute.LOOP:
                    self._mountpoints.pop(key, None)
            self._backends = {
                key: backend
                for key, backend in self._backends.items()
                if route_of(backend) is KernelRoute.LOOP
            }
            return
        self._mountpoints.clear()
        self._backends.clear()

    async def close_nfs(self) -> None:
        """Unmount every nfs prefix and stop the server. Idempotent."""
        self._deferred.clear()
        if not self._nfs:
            return
        for manager in list(self._nfs.values()):
            await manager.close()
        for key, backend in list(self._backends.items()):
            if route_of(backend) is KernelRoute.LOOP:
                self._mountpoints.pop(key, None)
                self._backends.pop(key, None)
        self._nfs.clear()

    @property
    def mountpoint(self) -> str | None:
        """The single active mountpoint, when there is exactly one.

        Raises:
            RuntimeError: more than one mount is active.
        """
        fuse = self.mountpoints
        if not fuse:
            return None
        if len(fuse) > 1:
            raise RuntimeError(
                "multiple FUSE mounts active; use fuse_mountpoints to "
                "select one by prefix")
        return next(iter(fuse.values()))

    @property
    def mountpoints(self) -> dict[str, str]:
        """The fuse and fskit mountpoints, keyed as they were added."""
        return {
            key: path
            for key, path in self._mountpoints.items()
            if self._route_of(key) is KernelRoute.THREAD
        }

    @property
    def nfs_mountpoints(self) -> dict[str, str]:
        """The nfs mountpoints, keyed as they were added."""
        return {
            key: path
            for key, path in self._mountpoints.items()
            if self._route_of(key) is KernelRoute.LOOP
        }

    def _route_of(self, key: str) -> KernelRoute:
        """How the mount registered under ``key`` was brought up.

        A key with no backend recorded is one nothing mounted, which is
        the same answer as a vfs mount: no kernel route.

        Args:
            key (str): the mount key, ``prefix`` or ``prefix@session``.

        Returns:
            KernelRoute: the route, or NONE when the key is unknown.
        """
        backend = self._backends.get(key)
        return KernelRoute.NONE if backend is None else route_of(backend)

    def _register(self, key: str, mountpoint: str) -> None:
        for other_key, other_mountpoint in self._mountpoints.items():
            if other_mountpoint == mountpoint and other_key != key:
                raise ValueError(
                    f"FUSE mountpoint {mountpoint!r} already used by "
                    f"prefix {other_key!r}; mounts need distinct paths")
        self._mountpoints[key] = mountpoint
