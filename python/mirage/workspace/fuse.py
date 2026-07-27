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
import subprocess
import sys
import tempfile
from threading import Thread

from mirage.fuse.backend import (FSKIT_MOUNT_ROOT, MountBackend,
                                 check_mountpoint, prepare_backend)
from mirage.fuse.mount import mount_background
from mirage.ops import Ops
from mirage.workspace.session.session import Session


class FuseManager:

    def __init__(self) -> None:
        self._mountpoint: str | None = None
        self._thread: Thread | None = None
        # True only for tempfile mountpoints Mirage created and may delete.
        self._owns_mountpoint: bool = False

    @property
    def mountpoint(self) -> str | None:
        return self._mountpoint

    def setup(self,
              ops: Ops,
              prefix: str = "/",
              mountpoint: str | None = None,
              session: Session | None = None,
              backend: str | MountBackend = MountBackend.FUSE) -> str:
        """Mount the ops tree and return the live mountpoint.

        Args:
            ops (Ops): the op facade to serve.
            prefix (str): mount root; non-empty scopes the tree.
            mountpoint (str | None): where to mount; None picks a temporary
                directory appropriate for the backend.
            session (Session | None): bind ops to this session's grants.
            backend (str | MountBackend): kernel interface to use.

        Returns:
            str: the mountpoint now serving the tree.
        """
        resolved = prepare_backend(backend)
        if mountpoint:
            # Caller/deployment-owned mountpoints may be reused across process
            # restarts, container lifecycles, or volume mounts. Mirage should
            # unmount them, but must not delete the directory itself.
            check_mountpoint(resolved, mountpoint)
            self._mountpoint = mountpoint
            self._owns_mountpoint = False
            os.makedirs(mountpoint, exist_ok=True)
        else:
            # FSKit refuses to mount outside /Volumes, so the default
            # temporary mountpoint moves there rather than the system temp
            # dir. The rule lives here so no call site has to know it.
            is_fskit = resolved is MountBackend.FSKIT
            parent = FSKIT_MOUNT_ROOT if is_fskit else None
            self._mountpoint = tempfile.mkdtemp(prefix="mirage-", dir=parent)
            self._owns_mountpoint = True
        self._thread = mount_background(ops,
                                        self._mountpoint,
                                        root_prefix=prefix,
                                        session=session,
                                        backend=resolved)
        return self._mountpoint

    def unmount(self) -> None:
        if not self._mountpoint:
            return
        if sys.platform == "darwin":
            subprocess.run(["diskutil", "unmount", "force", self._mountpoint],
                           capture_output=True)
        elif sys.platform == "win32":
            # No fusermount equivalent: WinFsp tears the mount down when the
            # serving process exits.
            pass
        else:
            subprocess.run(["fusermount", "-u", self._mountpoint],
                           capture_output=True)
        if self._owns_mountpoint:
            try:
                # Empty-directory cleanup only. If the mount is still live or
                # the directory has contents, leave it for the caller/admin.
                os.rmdir(self._mountpoint)
            except OSError:
                # non-empty or busy mountpoint: leave it for the caller/admin
                pass
        self._mountpoint = None
        self._owns_mountpoint = False

    def close(self) -> None:
        self.unmount()
