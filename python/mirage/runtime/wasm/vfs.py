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

import errno as host_errno
from datetime import datetime
from pathlib import Path
from typing import Any

from mirage.runtime.vfs import RuntimeVFS
from mirage.runtime.wasm.abi import FT_DIR, FT_UNKNOWN
from mirage.runtime.wasm.build import BuildDir
from mirage.runtime.wasm.config import WasmFsConfig
from mirage.runtime.wasm.constants import READONLY_HINT
from mirage.runtime.wasm.types import GuestStat
from mirage.types import FileType


def _mtime_ns(modified: str | None) -> int:
    """Convert a FileStat ISO timestamp to epoch nanoseconds.

    Args:
        modified (str | None): ISO-8601 timestamp, or None when the
            backend reports no mtime.
    """
    if not modified:
        return 0
    try:
        ts = datetime.fromisoformat(modified)
    except ValueError:
        return 0
    return int(ts.timestamp() * 1_000_000_000)


class WasmVFS:
    """The filesystem a wasm guest sees, over two sources.

    Routing is the wasm tier's own problem: a guest here is a whole
    interpreter, so its own build directory has to stay visible beside
    the workspace mounts. A mount prefix always wins, anything else
    falls to the build, and a path neither side holds is ENOENT.

    Its second job is shape. `RuntimeVFS` answers in mirage's terms
    (`FileStat`, virtual paths); preview1 asks in its own (`GuestStat`,
    `FT_DIR`/`FT_REG` pairs, errno). Translating between them is why
    quickjs still builds one of these even with no build directory to
    route to.

    Args:
        config (WasmFsConfig | dict | None): the knobs, chiefly which
            build directory to serve. None means no build directory.
        core (RuntimeVFS | None): the shared mount op vocabulary. None
            means no workspace is attached and only the build is
            visible.
    """

    def __init__(
        self,
        config: WasmFsConfig | dict[str, Any] | None = None,
        core: RuntimeVFS | None = None,
    ) -> None:
        self.config = WasmFsConfig.coerce(config)
        root = self.config.host_root
        self._build = BuildDir(Path(root)) if root is not None else None
        self._core = core

    def _prefixes(self) -> list[str]:
        """Mount prefixes that claim a path away from the build directory.

        A mount at `/` is left out, and this is the only place in the
        stack that treats it differently. Both readers here assume a
        prefix names a directory level: `_claimed_by_mount` takes a
        claim as exclusive, which for `/` would mean the interpreter's
        own build tree resolves through the workspace rather than off
        disk, and `_readdir_root` lists each prefix's first segment,
        which for `/` is the empty string. Leaving it out costs nothing:
        `_serving_build` already falls through to the core for every
        path the build does not hold, which is how a root mount is
        served here.
        """
        if self._core is None:
            return []
        return [p for p in self._core.prefixes() if p != "/"]

    def _claimed_by_mount(self, path: str) -> bool:
        for prefix in self._prefixes():
            if path == prefix or path.startswith(prefix + "/"):
                return True
        return False

    def _serving_build(self, path: str) -> BuildDir | None:
        """The build directory when it answers for `path`, else None.

        A mount prefix always wins. Below that: with no build there is
        nothing local to serve; with a build but no core the build owns
        every path, including a missing one, so the guest gets the
        build's own ENOENT; with both, the build answers only for what
        it holds and the core takes the rest.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: neither source can answer at all.
        """
        if self._claimed_by_mount(path):
            return None
        if self._build is None:
            if self._core is None:
                raise FileNotFoundError(path)
            return None
        if self._core is None:
            return self._build
        return self._build if self._build.has(path) else None

    def _deny_build(self, path: str) -> None:
        """Refuse a mutation that lands on the interpreter's own files.

        Args:
            path (str): guest-absolute path.

        Raises:
            PermissionError: the build directory serves this path.
        """
        if self._serving_build(path) is not None:
            raise PermissionError(READONLY_HINT)

    def _require_core(self) -> RuntimeVFS:
        if self._core is None:
            raise FileNotFoundError("no workspace mounts are reachable")
        return self._core

    def _core_call(self, op: str, path: str, **kwargs: Any) -> Any:
        if self._core is None:
            raise FileNotFoundError(path)
        return self._core.call(op, path, **kwargs)

    def stat(self, path: str) -> GuestStat:
        """Stat a guest path.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: the path exists on neither side.
        """
        build = self._serving_build(path)
        if build is not None:
            return build.stat(path)
        fs = self._core_call("stat", path)
        return GuestStat(is_dir=fs.type == FileType.DIRECTORY,
                         size=fs.size or 0,
                         mtime_ns=_mtime_ns(fs.modified))

    def stat_or_none(self, path: str) -> GuestStat | None:
        try:
            return self.stat(path)
        except (FileNotFoundError, NotADirectoryError):
            return None

    def read(self, path: str) -> bytes:
        build = self._serving_build(path)
        if build is not None:
            return build.read(path)
        data = self._core_call("read", path)
        if isinstance(data, str):
            return data.encode()
        return bytes(data)

    def write(self, path: str, data: bytes) -> None:
        self._deny_build(path)
        self._core_call("write", path, data=data)

    def create(self, path: str) -> None:
        self._deny_build(path)
        self._core_call("create", path)

    def truncate(self, path: str) -> None:
        self._deny_build(path)
        self._core_call("truncate", path, length=0)

    def unlink(self, path: str) -> None:
        self._deny_build(path)
        self._core_call("unlink", path)

    def mkdir(self, path: str) -> None:
        self._deny_build(path)
        self._core_call("mkdir", path)

    def rmdir(self, path: str) -> None:
        self._deny_build(path)
        self._core_call("rmdir", path)

    def rename(self, src: str, dst: str) -> None:
        """Rename within the workspace.

        Args:
            src (str): guest-absolute source path.
            dst (str): guest-absolute destination path.

        Raises:
            OSError: one end is on the build and the other is not.
            PermissionError: both ends are on the build.
        """
        src_build = self._serving_build(src) is not None
        dst_build = self._serving_build(dst) is not None
        if src_build or dst_build:
            if src_build != dst_build:
                raise OSError(host_errno.EXDEV, "cross-device rename", src)
            raise PermissionError(READONLY_HINT)
        self._require_core().rename(src, dst)

    def flush(self, path: str, base_len: int, low_write: int,
              buf: bytes | bytearray) -> None:
        """Send a closing handle's buffer, as a delta when it can be one.

        Args:
            path (str): guest-absolute path.
            base_len (int): length the file had when the handle opened.
            low_write (int): lowest offset this handle wrote at.
            buf (bytes | bytearray): the handle's whole buffer.
        """
        self._deny_build(path)
        self._require_core().flush(path, base_len, low_write, buf)

    def readdir(self, path: str) -> list[tuple[str, int]]:
        """List a guest directory as (name, preview1 filetype) pairs.

        Core entries whose kind the backend does not report come back
        FT_UNKNOWN; guests stat lazily when they care.

        Args:
            path (str): guest-absolute path.
        """
        if path == "/":
            return self._readdir_root()
        build = self._serving_build(path)
        if build is not None:
            return build.readdir(path)
        return self._readdir_core(path)

    def _readdir_core(self, path: str) -> list[tuple[str, int]]:
        names = self._core_call("readdir", path)
        entries: dict[str, int] = {}
        for raw in names:
            base = raw.rstrip("/").rsplit("/", 1)[-1]
            if not base:
                continue
            kind = FT_DIR if raw.endswith("/") else FT_UNKNOWN
            entries[base] = kind
        return sorted(entries.items())

    def _readdir_root(self) -> list[tuple[str, int]]:
        entries: dict[str, int] = {}
        if self._build is not None:
            for name, kind in self._build.readdir("/"):
                entries[name] = kind
        if self._core is not None:
            for name, kind in self._readdir_core("/"):
                entries.setdefault(name, kind)
            for prefix in self._prefixes():
                top = prefix.lstrip("/").split("/", 1)[0]
                entries[top] = FT_DIR
        return sorted(entries.items())
