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
from typing import Any, Callable, Literal

from mirage.runtime.errors import CrossMountError
from mirage.types import FileStat, PathSpec
from mirage.utils.errors import OperationNotSupportedError

FlushKind = Literal["append", "write"]


def plan_flush(base_len: int, low_write: int,
               buf: bytes | bytearray) -> tuple[FlushKind, bytes]:
    """Decide what a closing whole-file buffer owes the mount.

    Every encoder buffers a whole file and has to answer the same
    question at close: did this handle only add to the end, or did it
    rewrite what was already there? Only the first can travel as a
    delta, and answering "write" always is what makes an append loop
    quadratic.

    Args:
        base_len (int): length the file had when the handle opened.
        low_write (int): lowest offset this handle wrote at, or the
            base length when it never wrote below the end.
        buf (bytes | bytearray): the handle's whole buffer.

    Returns:
        tuple[FlushKind, bytes]: ("append", tail) when the handle only
        extended the file, else ("write", whole buffer).
    """
    if base_len > 0 and low_write >= base_len and len(buf) >= base_len:
        return "append", bytes(buf[base_len:])
    return "write", bytes(buf)


class RuntimeVFS:
    """The mount-facing op vocabulary a sandboxed runtime encodes into.

    One instruction set (read/write/append/stat/readdir/create/truncate/
    unlink/mkdir/rmdir/rename), one routing table, one place that knows
    an append may have to become a whole-file write. Encoders hold one
    of these; they never inherit it, because a monty encoder must
    inherit the binding's own OSAccess and a wasm encoder is a table of
    preview1 host functions.

    The surface is sync on purpose: guest calls arrive on a worker
    thread (wasm) or the binding's own thread (monty), so every op hops
    to the workspace loop with `run_coroutine_threadsafe` and blocks
    that caller. The hop carries the launching task's contextvars, so
    session mount modes are enforced inside the op exactly as they are
    for a shell command.

    Args:
        dispatch (Callable): the workspace dispatch coroutine function.
        loop (asyncio.AbstractEventLoop): the loop dispatch belongs to.
        mount_prefixes (Callable | None): live view of the workspace
            mount prefixes; None means routing questions answer None.
    """

    def __init__(
            self,
            dispatch: Callable[..., Any],
            loop: asyncio.AbstractEventLoop,
            mount_prefixes: Callable[[], list[str]] | None = None) -> None:
        self._dispatch = dispatch
        self._loop = loop
        self._mount_prefixes = mount_prefixes
        self._no_append: set[str] = set()

    def _raw(self, op: str, path: str, **kwargs: Any) -> Any:
        coro = self._dispatch(op, PathSpec.from_str_path(path), **kwargs)
        result, _ = asyncio.run_coroutine_threadsafe(coro, self._loop).result()
        return result

    def call(self, op: str, path: str, **kwargs: Any) -> Any:
        """Run one workspace op and return its result.

        Args:
            op (str): dispatch op name (read, write, stat, ...).
            path (str): guest-absolute virtual path.
        """
        try:
            return self._raw(op, path, **kwargs)
        except OperationNotSupportedError as exc:
            # execute_op raises this for an op the mount's resource does
            # not register; guests spell that ENOTSUP.
            raise NotImplementedError(str(exc)) from exc

    def prefixes(self) -> list[str]:
        """The workspace mount prefixes, longest first, slash-normalized."""
        if self._mount_prefixes is None:
            return []
        out = []
        for prefix in self._mount_prefixes():
            normed = "/" + prefix.strip("/")
            if normed != "/":
                out.append(normed)
        return sorted(out, key=len, reverse=True)

    def mount_of(self, path: str) -> str | None:
        """The mount prefix serving `path`, longest match first, or None.

        Args:
            path (str): guest-absolute virtual path.
        """
        for prefix in self.prefixes():
            if path == prefix or path.startswith(prefix + "/"):
                return prefix
        return None

    def read(self, path: str) -> bytes:
        data = self.call("read", path)
        if isinstance(data, str):
            return data.encode()
        return bytes(data)

    def write(self, path: str, data: bytes) -> None:
        self.call("write", path, data=data)

    def stat(self, path: str) -> FileStat:
        return self.call("stat", path)

    def readdir(self, path: str) -> list[str]:
        return list(self.call("readdir", path))

    def create(self, path: str) -> None:
        self.call("create", path)

    def truncate(self, path: str, length: int = 0) -> None:
        self.call("truncate", path, length=length)

    def unlink(self, path: str) -> None:
        self.call("unlink", path)

    def mkdir(self, path: str) -> None:
        self.call("mkdir", path)

    def rmdir(self, path: str) -> None:
        self.call("rmdir", path)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): guest-absolute source path.
            dst (str): guest-absolute destination path.

        Raises:
            CrossMountError: the two ends resolve to different mounts.
        """
        if self.mount_of(src) != self.mount_of(dst):
            raise CrossMountError(src, dst)
        self.call("rename", src, dst=PathSpec.from_str_path(dst))

    def append(self, path: str, data: bytes, whole: bytes) -> None:
        """Extend `path` by `data`, falling back to writing `whole`.

        `append` is optional per backend (S3 registers `write` and
        `rename` without it), so a mount that declines is remembered:
        the fallback then costs one failed dispatch per mount rather
        than one per call.

        Args:
            path (str): guest-absolute virtual path.
            data (bytes): only the newly appended bytes.
            whole (bytes): the file's full content, for the fallback.
        """
        if self._append_delta(path, data):
            return
        self.write(path, whole)

    def _append_delta(self, path: str, data: bytes) -> bool:
        mount = self.mount_of(path) or path
        if mount in self._no_append:
            return False
        try:
            self._raw("append", path, data=data)
        except OperationNotSupportedError:
            self._no_append.add(mount)
            return False
        return True

    def flush(self, path: str, base_len: int, low_write: int,
              buf: bytes | bytearray) -> None:
        """Send a closing handle's buffer as a delta when it can be one.

        Args:
            path (str): guest-absolute virtual path.
            base_len (int): length the file had when the handle opened.
            low_write (int): lowest offset this handle wrote at.
            buf (bytes | bytearray): the handle's whole buffer.
        """
        kind, payload = plan_flush(base_len, low_write, buf)
        if kind == "write":
            self.write(path, payload)
            return
        self.append(path, payload, bytes(buf))
