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
import errno
import logging
import os
import threading
from collections.abc import Coroutine
from typing import Any, Callable

from mirage.bridge.sync import run_async_from_sync
from mirage.context import reset_current_session, set_current_session
from mirage.fuse.darwin import rename_flags_check
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.ops import Ops
from mirage.types import JsonValue
from mirage.workspace.session.session import Session

logger = logging.getLogger(__name__)


class MirageFS:
    """libfuse adapter over MountCore.

    Owns exactly the FUSE-specific concerns: the mfusepy callback method
    signatures and the translation of mirage-native exceptions into
    ``OSError``. All filesystem semantics live in MountCore, so an FSKit or
    File Provider adapter can reuse them unchanged.

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
        self.core = MountCore(ops, root_prefix=root_prefix, session=session)
        # The loop the core's coroutines run on, and the thread serving
        # it. It lives here rather than in the core because the reason
        # for it is libfuse's: its callbacks are synchronous, so this
        # adapter -- and not the shared layer -- has to bridge. The nfs
        # delegate awaits the same core with no bridge at all.
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever,
                                             daemon=True)
        self._loop_thread.start()

    def _call(self, fn: Callable[..., Any], *args: Any) -> Any:
        """Run a core call, translating failures into FUSE error codes.

        Every exception is translated rather than propagated: an exception
        escaping a FUSE callback tears down the mount, so the kernel must
        always get a code. Anything that classifies as EIO without being a
        recognised I/O error is logged, so a genuine bug in the core still
        leaves a trace instead of silently reading as "I/O error".

        Args:
            fn (Callable): the MountCore coroutine function to invoke.
            *args (Any): arguments to forward to it.

        Returns:
            Any: whatever the core method returns.
        """
        return self._guard(fn, lambda: self._run(fn(*args)))

    def _call_sync(self, fn: Callable[..., Any], *args: Any) -> Any:
        """Run a core call that reaches no backend, with the same guard.

        The core answers some questions without touching the op facade --
        a namespace link's target, the statfs shape -- and those stayed
        synchronous when the rest became coroutines. Bridging one would
        try to await a plain value.

        Args:
            fn (Callable): the MountCore method to invoke.
            *args (Any): arguments to forward to it.

        Returns:
            Any: whatever the core method returns.
        """
        return self._guard(fn, lambda: fn(*args))

    def _guard(self, fn: Callable[..., Any], call: Callable[[], Any]) -> Any:
        """Translate any failure into a FUSE error code.

        Args:
            fn (Callable): the core method, named in the log line.
            call (Callable): the invocation to guard.

        Returns:
            Any: whatever the invocation returns.
        """
        try:
            return call()
        except Exception as err:
            code = classify_error(err)
            if code == errno.EIO and not isinstance(err,
                                                    (OSError, ValueError)):
                logger.warning("unclassified mount error in %s: %r",
                               fn.__name__, err)
            raise OSError(code, os.strerror(code)) from err

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """Drive one core coroutine to completion from a fuse callback.

        Args:
            coro (Coroutine): the core call to run.

        Returns:
            Any: whatever the coroutine returns.
        """
        if self.core.session is not None:
            coro = self._bind_session(coro)
        return run_async_from_sync(coro, self._loop)

    async def _bind_session(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """Run one op under the bound session's mount grants.

        The context is set inside the coroutine so it lands on the
        event-loop task that executes the op: a contextvar set on this
        thread would not travel with the coroutine to the loop's.

        Args:
            coro (Coroutine): the op coroutine to run under the session.

        Returns:
            Any: whatever the wrapped coroutine returns.
        """
        token = set_current_session(self.core.session)
        try:
            return await coro
        finally:
            reset_current_session(token)

    def drain_ops(self) -> list[dict[str, Any]]:
        return self.core.drain_ops()

    def getattr(self, path: str, fh: int | None = None) -> dict[str, Any]:
        # mfusepy wants libfuse's st_* spelling; the core answers in a
        # neutral row, so the translation lives here, in the adapter
        # whose binding needs it.
        return self._call(self.core.getattr, path, fh).as_stat_dict()

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
        return self._call_sync(self.core.readlink, path)

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
            # Bridged like every other core call: this one is a probe, so
            # its answer is discarded and only the raise matters.
            self._run(self.core.getattr(new))
            new_exists = True
        except (FileNotFoundError, ValueError):
            new_exists = False
        code = rename_flags_check(new_exists, flags)
        if code is not None:
            raise OSError(code, os.strerror(code))
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
