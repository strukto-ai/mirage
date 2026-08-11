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

from mirage.ops import Ops
from mirage.types import MountBackend
from mirage.workspace.fuse import FuseManager
from mirage.workspace.session import SessionManager


class KernelMounts:
    """The workspace's real mountpoints, one FuseManager per subtree.

    A ``vfs`` mount lives only inside mirage; a ``fuse`` or ``fskit``
    mount also registers a mountpoint with the kernel. This owns the
    set of those: which prefix is exposed where, and the manager
    serving it. Keys are ``prefix`` or ``prefix@session_id``, so the
    same subtree can be exposed both unbound and bound to a session.
    """

    def __init__(self, ops: Ops, sessions: SessionManager) -> None:
        self._ops = ops
        self._sessions = sessions
        self._mountpoints: dict[str, str] = {}
        self._managers: dict[str, FuseManager] = {}

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
        """
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
                                     backend=backend)
        except Exception:
            # The mount never came up; drop the manager and any
            # registered path so mountpoints does not misreport it.
            self._managers.pop(key, None)
            self._mountpoints.pop(key, None)
            raise
        if mountpoint is None:
            self._register(key, resolved)
        return resolved

    def remove(self, prefix: str, session_id: str | None = None) -> None:
        """Unmount one exposed subtree.

        Args:
            prefix (str): the virtual prefix that was exposed.
            session_id (str | None): session the mount was bound to.
        """
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        manager = self._managers.pop(key, None)
        if manager is not None:
            manager.unmount()
        self._mountpoints.pop(key, None)

    def close(self) -> None:
        """Unmount everything this workspace exposed."""
        for manager in list(self._managers.values()):
            manager.unmount()
        self._managers.clear()
        self._mountpoints.clear()

    @property
    def mountpoint(self) -> str | None:
        """The single active mountpoint, when there is exactly one.

        Raises:
            RuntimeError: more than one mount is active.
        """
        if not self._mountpoints:
            return None
        if len(self._mountpoints) > 1:
            raise RuntimeError(
                "multiple FUSE mounts active; use fuse_mountpoints to "
                "select one by prefix")
        return next(iter(self._mountpoints.values()))

    @property
    def mountpoints(self) -> dict[str, str]:
        return dict(self._mountpoints)

    def _register(self, key: str, mountpoint: str) -> None:
        for other_key, other_mountpoint in self._mountpoints.items():
            if other_mountpoint == mountpoint and other_key != key:
                raise ValueError(
                    f"FUSE mountpoint {mountpoint!r} already used by "
                    f"prefix {other_key!r}; mounts need distinct paths")
        self._mountpoints[key] = mountpoint
