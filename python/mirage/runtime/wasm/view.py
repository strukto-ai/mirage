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
from pathlib import Path
from typing import Any

from mirage.runtime.constants import ABSENT_PATH
from mirage.runtime.handles import FlushStep
from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.vfs import RuntimeVFS
from mirage.runtime.wasm.build import BuildDir
from mirage.runtime.wasm.config import WasmFsConfig
from mirage.runtime.wasm.constants import READONLY_HINT
from mirage.runtime.wasm.stat import filetype_of
from mirage.utils.path import owner_prefix


class WasmView:
    """The filesystem a wasm guest sees, over two sources.

    Routing is the wasm tier's own problem: a guest here is a whole
    interpreter, so its own build directory has to stay visible beside
    the workspace mounts. A mount prefix always wins, anything else
    falls to the build, and a path neither side holds is ENOENT.

    Its second job is shape. `RuntimeVFS` answers in virtual paths
    and one `VFSStat` per path; preview1 asks in `(name, filetype)`
    pairs and errno, and its filestat record has no mode field at all,
    so the type bits are read out of the mode and the rest is dropped.
    Translating between them is why quickjs still builds one of these
    even with no build directory to route to.

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

    async def abort(self) -> None:
        """Cancel the workspace operations owned by this guest."""
        if self._core is not None:
            await self._core.abort()

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
        return owner_prefix(self._prefixes(), path) is not None

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

    def _content_core(self, path: str) -> RuntimeVFS:
        """The door for a content call on `path`, inside the view only.

        Structure is open (a stat, a listing or a readlink answers for
        any path the workspace has), but content goes only through the
        runtime's view (``RuntimeVFS.serves``), the rule every guest
        door keeps: a guest reads and writes nothing the view
        withholds, such as the shell's history.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: no workspace is attached, or the view
                does not serve `path`.
        """
        if self._core is None or not self._core.serves(path):
            raise FileNotFoundError(path)
        return self._core

    def _core_call(self, op: str, path: str, **kwargs: Any) -> Any:
        return self._content_core(path).call(op, path, **kwargs)

    def stat(self, path: str) -> VFSStat:
        """Stat a guest path.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: the path exists on neither side.
        """
        build = self._serving_build(path)
        if build is not None:
            return build.stat(path)
        return self._core_stat(path)

    def lstat(self, path: str) -> VFSStat:
        """Stat a guest path without following a trailing symlink.

        A link's own row is the node table's, not a backend's, and the
        door serves it under `nofollow`: the row carries the target's
        byte length as the size, the link's own mtime, and whatever a
        `chown -h` or a no-follow `utime` wrote, none of which a row
        rebuilt here from the target string could report. Every other
        path answers exactly as `stat` does. A build path can never be
        a link, so it takes the ordinary path.

        Args:
            path (str): guest-absolute path.

        Raises:
            FileNotFoundError: the path exists on neither side.
        """
        if self._serving_build(path) is not None:
            return self.stat(path)
        return self._core_stat(path, nofollow=True)

    def _core_stat(self, path: str, nofollow: bool = False) -> VFSStat:
        """The door's own stat, or ENOENT when no workspace is attached.

        A path outside the view still answers as structure: a directory
        row when the workspace lists it (``RuntimeVFS.view_stat``).

        Args:
            path (str): guest-absolute path.
            nofollow (bool): report a trailing symlink itself.
        """
        if self._core is None:
            raise FileNotFoundError(path)
        if self._core.serves(path):
            return self._core.stat(path, nofollow=nofollow)
        row = self._core.view_stat(path)
        if row is None:
            raise FileNotFoundError(path)
        return row

    def stat_or_none(
        self, path: str, *, nofollow: bool = False
    ) -> VFSStat | None:
        """The path's row, or None when neither side has it.

        Args:
            path (str): guest-absolute path.
            nofollow (bool): report a trailing symlink itself.
        """
        try:
            return self.lstat(path) if nofollow else self.stat(path)
        except ABSENT_PATH:
            return None

    def listing_or_none(self, path: str) -> list[VFSEntry] | None:
        """The mount's unclassified rows for `path`, or None.

        Asked of a path with no row. The build directory holds rows for
        everything it holds, so a path it serves never lists here, and
        neither does a path outside the view: its stat already answered
        the directory row ``RuntimeVFS.view_stat`` finds. The history
        mount lists its one file as empty, and that file is withheld, not
        a directory.

        Args:
            path (str): guest-absolute path.
        """
        try:
            build = self._serving_build(path)
        except FileNotFoundError:
            return None
        if build is not None:
            return None
        core = self._require_core()
        if not core.serves(path):
            return None
        return core.listing_or_none(path)

    def read(
        self,
        path: str,
        *,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
    ) -> bytes:
        """A file's bytes, or a range of them, from the build or the
        workspace.

        Args:
            path (str): guest-absolute path.
            offset (int): where the range starts.
            size (int | None): its length; None reads to the end.
            raw (bool): the stored bytes rather than a rendering.
        """
        build = self._serving_build(path)
        if build is not None:
            return build.read(path, offset=offset, size=size)
        return self._content_core(path).read(
            path, offset=offset, size=size, raw=raw
        )

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
        self._content_core(dst)
        self._content_core(src).rename(src, dst)

    def symlink(self, path: str, target: str) -> None:
        """Create a symlink at `path` pointing at `target`.

        Args:
            path (str): guest-absolute path of the link.
            target (str): what the link points to, stored as typed.
        """
        self._deny_build(path)
        self._core_call("symlink", path, target=target)

    def readlink(self, path: str) -> str:
        """The target of the symlink at `path`.

        Args:
            path (str): guest-absolute path of the link.

        Raises:
            OSError: EINVAL when the path is not a link, which is what
                readlink(2) answers and what the node table reports. A
                build path answers that too rather than the read-only
                refusal: reading is not the mutation `_deny_build`
                guards, and the build holds no links.
        """
        if self._serving_build(path) is not None:
            raise OSError(host_errno.EINVAL, "not a symbolic link", path)
        if self._core is None:
            raise FileNotFoundError(path)
        return str(self._core.call("readlink", path))

    def setattr(
        self,
        path: str,
        *,
        atime: str | None,
        mtime: str | None,
        nofollow: bool,
    ) -> None:
        """Write timestamps, in the namespace overlay where needed.

        Times are the only attributes preview1 can express: it has no
        chmod or chown call at all. A mount whose backend cannot hold a
        stamp still answers, because the door overlays what the backend
        declines.

        Args:
            path (str): guest-absolute path.
            atime (str | None): ISO access time, None to leave it.
            mtime (str | None): ISO modification time, None to leave it.
            nofollow (bool): stamp the link itself, not its target.
        """
        self._deny_build(path)
        self._content_core(path).setattr(
            path, atime=atime, mtime=mtime, nofollow=nofollow
        )

    def flush(self, path: str, steps: list[FlushStep]) -> None:
        """Send what a closing handle owes the mount.

        Args:
            path (str): guest-absolute path.
            steps (list[FlushStep]): the handle's ``flush_plan()``.
        """
        self._deny_build(path)
        self._content_core(path).flush(path, steps)

    def readdir(self, path: str) -> list[tuple[str, int]]:
        """List a guest directory as (name, preview1 filetype) pairs.

        Core entries arrive kind-resolved (the door stats what the
        backend does not slash-mark), so a guest's ``d_type`` is real
        instead of FT_UNKNOWN paid off with one lazy stat per entry.
        The exception is an entry whose stat failed: it rides
        unclassified, so it is FT_UNKNOWN, and a guest that needs its
        kind stats it and meets the failure there rather than a guess.
        A link is reported as one: preview1 has the filetype, the door
        marks the row, and a guest that reads ``d_type`` (CPython's
        ``scandir`` does) then answers ``is_symlink`` without a call of
        its own.

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
        entries: dict[str, int] = {}
        for entry in self._require_core().readdir(path):
            base = entry.path.rstrip("/").rsplit("/", 1)[-1]
            if base:
                entries[base] = filetype_of(entry)
        return sorted(entries.items())

    def _readdir_root(self) -> list[tuple[str, int]]:
        """Merge the build directory's root listing with the core's.

        The core's readdir already carries mount structure (the door
        merges child mounts and links), so no prefix synthesis happens
        here; mount entries arrive kind-resolved by the core listing,
        which the door also answers for structure-only directories.
        """
        entries: dict[str, int] = {}
        if self._build is not None:
            for name, kind in self._build.readdir("/"):
                entries[name] = kind
        if self._core is not None:
            for name, kind in self._readdir_core("/"):
                entries.setdefault(name, kind)
        return sorted(entries.items())
