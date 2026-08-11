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

import errno
import logging
from typing import Any, Callable

try:
    import mfusepy as fuse
except ImportError:
    fuse = None

from mirage.fuse.core import MountCore
from mirage.fuse.darwin import rename_flags_check
from mirage.fuse.errors import classify_error
from mirage.ops import Ops
from mirage.types import JsonValue
from mirage.workspace.session.session import Session

logger = logging.getLogger(__name__)

# Base class only when mfusepy is installed; otherwise the module still imports
# (FUSE is the optional [fuse] extra) but instantiating MirageFS raises.
_FUSE_OPERATIONS: Any = fuse.Operations if fuse is not None else object


class MirageFS(_FUSE_OPERATIONS):
    """libfuse adapter over MountCore.

    Owns exactly the FUSE-specific concerns: the mfusepy ``Operations``
    method signatures and the translation of mirage-native exceptions into
    ``FuseOSError``. All filesystem semantics live in MountCore, so an
    FSKit or File Provider adapter can reuse them unchanged.

    Args:
        ops (Ops): the workspace op facade every callback routes to.
        root_prefix (str): mount root; non-empty scopes the tree to one mount.
        session (Session | None): bind every op to this session's mount grants.
    """

    use_ns = True

    def __init__(self,
                 ops: Ops,
                 root_prefix: str = "",
                 session: Session | None = None) -> None:
        if fuse is None:
            raise RuntimeError(
                "FUSE support requires the 'fuse' extra: install "
                '"mirage-ai[fuse]" plus the OS driver (macFUSE, fuse3, or '
                "WinFsp). Setup and support matrix: "
                "https://mirage.dev/home/setup/fuse")
        self.core = MountCore(ops, root_prefix=root_prefix, session=session)

    def _call(self, fn: Callable[..., Any], *args: Any) -> Any:
        """Run a core call, translating failures into FUSE error codes.

        Every exception is translated rather than propagated: an exception
        escaping a FUSE callback tears down the mount, so the kernel must
        always get a code. Anything that classifies as EIO without being a
        recognised I/O error is logged, so a genuine bug in the core still
        leaves a trace instead of silently reading as "I/O error".

        Args:
            fn (Callable): the MountCore method to invoke.
            *args (Any): arguments to forward to it.

        Returns:
            Any: whatever the core method returns.
        """
        try:
            return fn(*args)
        except Exception as err:
            code = classify_error(err)
            if code == errno.EIO and not isinstance(err,
                                                    (OSError, ValueError)):
                logger.warning("unclassified mount error in %s: %r",
                               fn.__name__, err)
            raise fuse.FuseOSError(code) from err

    def drain_ops(self) -> list[dict[str, Any]]:
        return self.core.drain_ops()

    def getattr(self, path: str, fh: int | None = None) -> dict[str, Any]:
        return self._call(self.core.getattr, path, fh)

    def readdir(self, path: str, fh: int) -> list[Any]:
        return self._call(self.core.readdir, path)

    def read(self, path: str, size: int, offset: int, fh: int) -> bytes:
        return self._call(self.core.read, path, size, offset, fh)

    def write(self, path: str, data: bytes, offset: int, fh: int) -> int:
        return self._call(self.core.write, path, data, offset, fh)

    def create(self, path: str, mode: int, fi: Any = None) -> int:
        return self._call(self.core.create, path)

    def mkdir(self, path: str, mode: int) -> None:
        self._call(self.core.mkdir, path)

    def readlink(self, path: str) -> str:
        return self._call(self.core.readlink, path)

    def symlink(self, target: str, source: str) -> None:
        self._call(self.core.symlink, target, source)

    def unlink(self, path: str) -> None:
        self._call(self.core.unlink, path)

    def rename(self, old: str, new: str, flags: int = 0) -> None:
        self._call(self.core.rename, old, new)

    def renamex(self, old: str, new: str, flags: int = 0) -> int:
        # macFUSE's Darwin-only rename entry point (fuse/darwin.py). The
        # FSKit shim routes every rename here and never issues the plain
        # RENAME op, so without this method mv fails with ENOSYS before
        # reaching userspace.
        try:
            self.core.getattr(new)
            new_exists = True
        except (FileNotFoundError, ValueError):
            new_exists = False
        code = rename_flags_check(new_exists, flags)
        if code is not None:
            raise fuse.FuseOSError(code)
        self._call(self.core.rename, old, new)
        return 0

    def setattr_x(self, path: str, changes: dict[str, JsonValue]) -> int:
        # macFUSE prefers this single entry point over chmod/chown/
        # truncate/utimens whenever it is implemented, and the FSKit shim
        # depends on it: createItem/createDirectory finalize the new item
        # with a SETATTR (mode|uid|gid|crtime|flags), which used to hit a
        # NULL slot and fail the whole create with ENOSYS after the file
        # had already landed. Size changes route to truncate; the other
        # attributes follow the same accept-if-the-path-exists semantics
        # as chmod/chown/utimens above.
        size = changes.get("size")
        if isinstance(size, int):
            self._call(self.core.truncate, path, size)
        else:
            self._call(self.core.getattr, path)
        return 0

    def fsetattr_x(self,
                   path: str,
                   changes: dict[str, JsonValue],
                   fh: int | None = None) -> int:
        return self.setattr_x(path, changes)

    def rmdir(self, path: str) -> None:
        self._call(self.core.rmdir, path)

    def statfs(self, path: str) -> dict[str, Any]:
        return self.core.statfs()

    def chmod(self, path: str, mode: int) -> None:
        self._call(self.core.getattr, path)

    def chown(self, path: str, uid: int, gid: int) -> None:
        self._call(self.core.getattr, path)

    def utimens(self, path: str, times: Any = None) -> None:
        self._call(self.core.getattr, path)

    def access(self, path: str, amode: int) -> None:
        self._call(self.core.getattr, path)

    def setxattr(self,
                 path: str,
                 name: str,
                 value: bytes,
                 options: int,
                 position: int = 0) -> int:
        self._call(self.core.setxattr, path, name, value)
        return 0

    def getxattr(self, path: str, name: str, position: int = 0) -> bytes:
        return self._call(self.core.getxattr, path, name)

    def listxattr(self, path: str) -> list[str]:
        return self._call(self.core.listxattr, path)

    def removexattr(self, path: str, name: str) -> int:
        self._call(self.core.removexattr, path, name)
        return 0

    def flush(self, path: str, fh: int) -> None:
        self._call(self.core.flush, path, fh)

    def fsync(self, path: str, datasync: int, fh: int) -> None:
        self.flush(path, fh)

    def open(self, path: str, flags: int) -> int:
        return self._call(self.core.open, path)

    def release(self, path: str, fh: int) -> int:
        self._call(self.core.release, fh)
        return 0

    def truncate(self, path: str, length: int, fh: int | None = None) -> None:
        self._call(self.core.truncate, path, length)
