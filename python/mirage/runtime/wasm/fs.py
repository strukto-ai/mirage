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
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from mirage.runtime.wasm.abi import FT_DIR, FT_REG, FT_UNKNOWN
from mirage.runtime.wasm.bridge import SyncDispatch
from mirage.types import FileType, PathSpec

_READONLY_HINT = "interpreter build directory is read-only"


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


@dataclass(frozen=True, slots=True)
class GuestStat:
    is_dir: bool
    size: int
    mtime_ns: int


class GuestFs:
    """Route guest-absolute paths to the interpreter build or workspace.

    Paths under a workspace mount prefix bridge to the dispatch (cache
    read-through, write modes, session narrowing — the same path shell
    commands take). Everything else is served read-only from the host
    build directory, so the interpreter's own files stay local and
    fast. A path in neither answers ENOENT. Without a bridge, only the
    build directory is visible; without a build directory (quickjs),
    everything bridges.
    """

    def __init__(
        self,
        host_root: Path | None = None,
        bridge: SyncDispatch | None = None,
        mount_prefixes: Callable[[], list[str]] | None = None,
    ) -> None:
        self._host_root = Path(host_root) if host_root is not None else None
        self._bridge = bridge
        self._mount_prefixes = mount_prefixes

    def _prefixes(self) -> list[str]:
        if self._bridge is None or self._mount_prefixes is None:
            return []
        out = []
        for prefix in self._mount_prefixes():
            normed = "/" + prefix.strip("/")
            if normed != "/":
                out.append(normed)
        return sorted(out, key=len, reverse=True)

    def _host_target(self, path: str) -> Path | None:
        """Resolve a guest path to the host build, or None for the bridge.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: no host build and no bridge to serve it.
        """
        for prefix in self._prefixes():
            if path == prefix or path.startswith(prefix + "/"):
                return None
        if self._host_root is None:
            if self._bridge is None:
                raise FileNotFoundError(path)
            return None
        rel = path.lstrip("/")
        host = self._host_root / rel if rel else self._host_root
        if self._bridge is None:
            return host
        return host if path == "/" or host.exists() else None

    def _bridge_call(self, op: str, path: str, **kwargs: Any) -> Any:
        if self._bridge is None:
            raise FileNotFoundError(path)
        return self._bridge.call(op, path, **kwargs)

    def stat(self, path: str) -> GuestStat:
        """Stat a guest path.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: the path exists on neither side.
        """
        host = self._host_target(path)
        if host is not None:
            st = os.stat(host)
            return GuestStat(is_dir=host.is_dir(),
                             size=st.st_size,
                             mtime_ns=st.st_mtime_ns)
        fs = self._bridge_call("stat", path)
        return GuestStat(is_dir=fs.type == FileType.DIRECTORY,
                         size=fs.size or 0,
                         mtime_ns=_mtime_ns(fs.modified))

    def stat_or_none(self, path: str) -> GuestStat | None:
        try:
            return self.stat(path)
        except (FileNotFoundError, NotADirectoryError):
            return None

    def read(self, path: str) -> bytes:
        host = self._host_target(path)
        if host is not None:
            return host.read_bytes()
        data = self._bridge_call("read", path)
        if isinstance(data, str):
            return data.encode()
        return bytes(data)

    def write(self, path: str, data: bytes) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("write", path, data=data)

    def create(self, path: str) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("create", path)

    def truncate(self, path: str) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("truncate", path, length=0)

    def unlink(self, path: str) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("unlink", path)

    def mkdir(self, path: str) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("mkdir", path)

    def rmdir(self, path: str) -> None:
        if self._host_target(path) is not None:
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("rmdir", path)

    def rename(self, src: str, dst: str) -> None:
        """Rename within the workspace.

        Args:
            src (str): guest-absolute source path.
            dst (str): guest-absolute destination path.
        """
        src_host = self._host_target(src) is not None
        dst_host = self._host_target(dst) is not None
        if src_host or dst_host:
            if src_host != dst_host:
                raise OSError(host_errno.EXDEV, "cross-device rename", src)
            raise PermissionError(_READONLY_HINT)
        self._bridge_call("rename", src, dst=PathSpec.from_str_path(dst))

    def readdir(self, path: str) -> list[tuple[str, int]]:
        """List a guest directory as (name, preview1 filetype) pairs.

        Bridge entries whose kind the backend does not report come back
        FT_UNKNOWN; guests stat lazily when they care.

        Args:
            path (str): guest-absolute path.
        """
        if path == "/":
            return self._readdir_root()
        host = self._host_target(path)
        if host is not None:
            return self._readdir_host(host)
        return self._readdir_bridge(path)

    def _readdir_host(self, host: Path) -> list[tuple[str, int]]:
        entries = []
        for entry in os.scandir(host):
            entries.append((entry.name, FT_DIR if entry.is_dir() else FT_REG))
        return sorted(entries)

    def _readdir_bridge(self, path: str) -> list[tuple[str, int]]:
        names = self._bridge_call("readdir", path)
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
        if self._host_root is not None:
            for name, kind in self._readdir_host(self._host_root):
                entries[name] = kind
        if self._bridge is not None:
            for name, kind in self._readdir_bridge("/"):
                entries.setdefault(name, kind)
            for prefix in self._prefixes():
                top = prefix.lstrip("/").split("/", 1)[0]
                entries[top] = FT_DIR
        return sorted(entries.items())
