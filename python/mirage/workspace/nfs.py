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
import logging
import os
import tempfile
from threading import Thread

from mirage.fuse.backend import check_sizes
from mirage.fuse.mount import canonical_mountpoint
from mirage.mount.core import MountCore
from mirage.mount.nfs import (
    MOUNT_TIMEOUT,
    MirageNFSServer,
    mount_nfs,
    unmount_nfs,
)
from mirage.types import MountBackend
from mirage.workspace.files import WorkspaceFiles
from mirage.workspace.session.session import SessionState

logger = logging.getLogger(__name__)


class NFSManager:
    """Mounts one workspace subtree through the operating system's own
    NFS client: a ``MirageNFSServer`` on a loop thread of its own, and the
    system ``mount`` pointed at it. The server keeps answering while the
    process's own threads read the mountpoint, as a FUSE mount's does.
    """

    def __init__(self) -> None:
        self._mountpoint: str | None = None
        # Where the kernel mounts: the path resolved at mount time, which
        # every unmount targets.
        self._kernel_mountpoint: str | None = None
        # True only for tempfile mountpoints Mirage created and may delete.
        self._owns_mountpoint = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: Thread | None = None
        self._server: MirageNFSServer | None = None

    @property
    def mountpoint(self) -> str | None:
        return self._mountpoint

    def setup(
        self,
        files: WorkspaceFiles,
        prefix: str = "/",
        mountpoint: str | None = None,
        session: SessionState | None = None,
    ) -> str:
        """Serve the workspace's files over NFS, mount them, and return the
        live mountpoint.

        Args:
            files (WorkspaceFiles): ``ws.vfs`` to serve.
            prefix (str): mount root; non-empty scopes the tree.
            mountpoint (str | None): where to mount; None picks a temporary
                directory.
            session (SessionState | None): bind ops to this session's grants.

        Returns:
            str: the mountpoint now serving the tree.

        Raises:
            RuntimeError: the system mount refused.
        """
        check_sizes(MountBackend.NFS, files, prefix)
        owns = mountpoint is None
        if mountpoint is None:
            mountpoint = tempfile.mkdtemp(prefix="mirage-")
        else:
            os.makedirs(mountpoint, exist_ok=True)
        kernel = canonical_mountpoint(mountpoint)
        loop = asyncio.new_event_loop()
        thread = Thread(
            target=loop.run_forever, name="mirage-nfs", daemon=True
        )
        thread.start()
        server = MirageNFSServer(
            MountCore(files, root_prefix=prefix, session=session)
        )
        self._loop, self._thread, self._server = loop, thread, server
        try:
            started = asyncio.run_coroutine_threadsafe(server.start(), loop)
            mount_nfs(started.result(MOUNT_TIMEOUT), kernel)
        except BaseException:
            self._stop()
            if owns:
                self._remove(kernel)
            raise
        self._mountpoint, self._owns_mountpoint = mountpoint, owns
        self._kernel_mountpoint = kernel
        return mountpoint

    def unmount(self) -> None:
        """Unmount, then stop the server: the other order would leave the
        kernel waiting on a server that is gone."""
        kernel = self._kernel_mountpoint
        if kernel is not None:
            unmount_nfs(kernel)
        self._stop()
        if kernel is not None and self._owns_mountpoint:
            self._remove(kernel)
        self._mountpoint = self._kernel_mountpoint = None
        self._owns_mountpoint = False

    def _stop(self) -> None:
        loop, thread, server = self._loop, self._thread, self._server
        self._loop = self._thread = self._server = None
        if loop is None:
            return
        if server is not None:
            closed = asyncio.run_coroutine_threadsafe(server.close(), loop)
            try:
                closed.result(MOUNT_TIMEOUT)
            except Exception as err:
                logger.debug("nfs: closing the server failed: %r", err)
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(MOUNT_TIMEOUT)
        loop.close()

    @staticmethod
    def _remove(mountpoint: str) -> None:
        try:
            # Empty-directory cleanup only; a mount still live keeps it.
            os.rmdir(mountpoint)
        except OSError as err:
            logger.debug("nfs: removing %s failed: %r", mountpoint, err)
