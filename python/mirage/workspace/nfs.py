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

import os
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.nfs.config import NFSConfig
from mirage.nfs.mount import (prepare_mountpoint, run_mount, run_umount,
                              start_server)
from mirage.nfs.session import NFSDelegate
from mirage.ops import Ops
from mirage.workspace.session.session import Session

StartFn = Callable[[Ops, NFSConfig, "Session | None"],
                   Awaitable[tuple[NFSDelegate, Any]]]
MountFn = Callable[[str, int, str, NFSConfig | None], Awaitable[None]]
UnmountFn = Callable[[str], Awaitable[None]]


class NFSManager:
    """One NFS server, many kernel mounts.

    The MOUNT protocol takes a path, so a single server exposing the
    whole op tree can back any number of kernel mountpoints, each
    mounting a different export (``127.0.0.1:/`` here, ``:/docs``
    there). That is the one-per-process limit macOS FUSE lives under,
    dissolved: the server starts lazily on the first mount and every
    later mount reuses it.

    Everything is async and thread-free, so this manager is only
    reachable from an async context.

    One manager is one session's view, because one server serves one
    delegate. A session-scoped mount therefore does not narrow this
    server; it gets a second one, which is what ``KernelMounts`` keeps
    a manager per session for. The session is fixed by the first mount
    for the same reason the config is.

    Args:
        start_fn (StartFn): starts the server; injectable for tests.
        mount_fn (MountFn): runs one kernel mount; injectable.
        unmount_fn (UnmountFn): tears one down; injectable.
    """

    def __init__(self,
                 start_fn: StartFn = start_server,
                 mount_fn: MountFn = run_mount,
                 unmount_fn: UnmountFn = run_umount) -> None:
        self._start = start_fn
        self._mount = mount_fn
        self._unmount = unmount_fn
        self._fs: NFSDelegate | None = None
        self._session: Session | None = None
        self._handle: Any | None = None
        self._config: NFSConfig | None = None
        self._mounts: dict[str, tuple[str, bool]] = {}

    @property
    def mountpoints(self) -> dict[str, str]:
        """Live mounts, prefix to mountpoint."""
        return {prefix: path for prefix, (path, _) in self._mounts.items()}

    async def setup(self,
                    ops: Ops,
                    prefix: str = "/",
                    mountpoint: str | None = None,
                    config: NFSConfig | None = None,
                    session: Session | None = None) -> str:
        """Expose ``prefix`` at a kernel mountpoint and return its path.

        The first call starts the server and fixes its config and its
        session; later calls reuse all three, so ``config`` is honored
        only once and a different ``session`` is refused rather than
        quietly ignored -- one server serves one delegate, and a second
        session's mounts belong to a second manager.

        Args:
            ops (Ops): the op facade to serve.
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a
                temporary directory mirage owns.
            config (NFSConfig | None): server knobs, first call only.
            session (Session | None): scope every op to this session's
                mount grants, first call only.

        Returns:
            str: the mountpoint now serving the prefix.

        Raises:
            ValueError: the mountpoint already serves another prefix,
                the prefix is already mounted, or a live server is bound
                to a different session.
        """
        # Collision answers from the registry BEFORE the path is
        # touched: a colliding mountpoint may be a live mount served by
        # this very loop, and prepare_mountpoint stats it (makedirs ->
        # isdir), which is the self-touch deadlock in miniature.
        if mountpoint is not None:
            for other_prefix, (other_path, _) in self._mounts.items():
                if other_path == mountpoint:
                    raise ValueError(
                        f"nfs mountpoint {mountpoint!r} already serves "
                        f"{other_prefix!r}")
        # And the prefix, for the same reason from the other side. The
        # registry is keyed by prefix, so a second setup of one already
        # mounted overwrote its entry -- and close() unmounts what the
        # registry holds, so the first mountpoint stayed live with no
        # server behind it, which is the exact state the soft-mount and
        # teardown work exists to prevent.
        existing = self._mounts.get(prefix)
        if existing is not None:
            raise ValueError(
                f"nfs prefix {prefix!r} is already mounted at "
                f"{existing[0]!r}; unmount it before mounting it again")
        if self._handle is not None and session is not self._session:
            raise ValueError(
                "this nfs server is bound to a different session; a "
                "session-scoped mount needs its own manager")
        resolved, owns = prepare_mountpoint(mountpoint)
        if self._handle is None:
            self._config = config or NFSConfig()
            self._session = session
            self._fs, self._handle = await self._start(ops, self._config,
                                                       session)
        export = ("/" if prefix.strip("/") == "" else "/" + prefix.strip("/"))
        try:
            await self._mount(resolved, self._handle.port(), export,
                              self._config)
        except Exception:
            self._discard_mountpoint(resolved, owns)
            raise
        self._mounts[prefix] = (resolved, owns)
        return resolved

    async def unmount(self, prefix: str) -> None:
        """Tear down one exposed prefix. Missing prefixes are a no-op.

        Args:
            prefix (str): the virtual prefix that was exposed.
        """
        entry = self._mounts.pop(prefix, None)
        if entry is None:
            return
        path, owns = entry
        await self._unmount(path)
        self._discard_mountpoint(path, owns)

    async def close(self) -> None:
        """Unmount everything, flush buffered writes, stop the server.

        The order is load-bearing: unmounting makes the kernel client
        flush its dirty pages as final WRITEs, which need a live
        server; ``flush_all`` then stores whatever is still buffered;
        only then does the server stop. Idempotent.
        """
        for prefix in list(self._mounts):
            await self.unmount(prefix)
        if self._fs is not None:
            await self._fs.flush_all()
        if self._handle is not None:
            self._handle.stop()
        self._fs = None
        self._handle = None
        self._config = None
        self._session = None

    def _discard_mountpoint(self, path: str, owns: bool) -> None:
        """Remove a mirage-owned, now-empty mountpoint directory.

        Args:
            path (str): the mountpoint path.
            owns (bool): whether mirage created it.
        """
        if not owns:
            return
        try:
            os.rmdir(path)
        except OSError:
            # busy or non-empty: the caller/admin's to clean, never ours
            # to force
            return
