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
from pathlib import PurePosixPath
from typing import Any

from mirage.runtime.errors import CrossMountError
from mirage.runtime.handles import parse_mode
from mirage.runtime.python.monty.binding import (MemoryFile, MontyFileHandle,
                                                 OSAccess, path_from_arg)
from mirage.runtime.python.monty.constants import (EXDEV_MESSAGE,
                                                   FILE_EXISTS_MESSAGE)
from mirage.runtime.python.monty.vfs import MontyVFS
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn
from mirage.runtime.vfs import RuntimeVFS


class MirageOSAccess(OSAccess):
    """Monty's OS door, backfilling files from the workspace on demand.

    This is monty's tier of the interception taxonomy: the binding hands
    the interpreter a host OS object and calls its methods, so mirage
    subclasses that object rather than hooking a syscall layer. Reads
    materialize the file into the in-memory tree on first touch; writes
    go through the tree first (Monty's own open/append semantics) and
    are then flushed back through `MontyVFS`. Runs on Monty's worker
    thread, so every op hops to the workspace loop inside the core.

    The binding only accepts sync callbacks (pydantic/monty#560), so the
    core's hop parks the tokio worker for the whole I/O wait. That caps
    concurrent I/O-waiting runs at Monty's worker pool size, which is
    the core count by default; TOKIO_WORKER_THREADS raises it, and
    parked workers cost stack pages, not CPU (measured: 100 concurrent
    1s-I/O runs finish in ~2s at 64 workers versus ~8s at 14).

    Args:
        loop (asyncio.AbstractEventLoop): the workspace's event loop.
        dispatch (Callable | None): the workspace dispatch coroutine
            function, None outside a workspace.
        environ (dict[str, str]): the guest's environment.
        resolver (MountResolver | None): the workspace mount routing
            table, None outside a workspace.
    """

    def __init__(self,
                 loop: asyncio.AbstractEventLoop,
                 dispatch: DispatchFn | None,
                 environ: dict[str, str],
                 resolver: MountResolver | None = None) -> None:
        super().__init__([], environ=dict(environ))
        core = (RuntimeVFS(dispatch, loop, resolver)
                if dispatch is not None else None)
        self._vfs = MontyVFS(core)

    def _fetch(self, virtual: str) -> bytes | None:
        return self._vfs.read(virtual)

    def _list_remote(self, virtual: str) -> list[str] | None:
        entries = self._vfs.readdir(virtual)
        if entries is None:
            return None
        return [entry.path for entry in entries]

    def _tree_bytes(self, path: PurePosixPath) -> bytes | None:
        entry = self._get_entry(path)
        if entry is None or isinstance(entry, dict):
            return None
        content = entry.read_content()
        return content.encode() if isinstance(content, str) else bytes(content)

    def _flush(self, path: PurePosixPath) -> None:
        data = self._tree_bytes(path)
        if data is None:
            return
        self._vfs.write(str(path), data)

    def _append_remote(self, path: PurePosixPath, data: bytes) -> None:
        """Send only the appended bytes when the mount can take them.

        Monty hands an append hook the new text alone, so a mount with
        its own append op carries just that. Flushing instead re-sends
        every byte written so far, which turns a write loop quadratic:
        200 appends of one short line shipped 164 KB to build a 1.7 KB
        file before this.

        Args:
            path (PurePosixPath): the file being appended to.
            data (bytes): only the newly appended bytes.
        """
        whole = self._tree_bytes(path)
        if whole is None:
            return
        self._vfs.append(str(path), data, whole)

    def _insert_tree_dir(self, path: PurePosixPath) -> dict[str, Any] | None:
        subtree = self._tree
        for part in path.parts:
            entry = subtree.setdefault(part, {})
            if not isinstance(entry, dict):
                return None
            subtree = entry
        return subtree

    def _ensure_file(self, path: PurePosixPath) -> None:
        if self._get_entry(path) is not None:
            return
        data = self._fetch(str(path))
        if data is None:
            return
        parent = self._insert_tree_dir(path.parent)
        if parent is None:
            return
        memory = MemoryFile(path, data)
        parent[path.name] = memory
        self.files.append(memory)

    def _ensure_dir(self, path: PurePosixPath) -> None:
        entry = self._get_entry(path)
        if entry is not None:
            return
        if self._list_remote(str(path)) is None:
            return
        self._insert_tree_dir(path)

    def path_exists(self, path: PurePosixPath) -> bool:
        self._ensure_file(path)
        if super().path_exists(path):
            return True
        self._ensure_dir(path)
        return super().path_exists(path)

    def path_is_file(self, path: PurePosixPath) -> bool:
        self._ensure_file(path)
        return super().path_is_file(path)

    def path_is_dir(self, path: PurePosixPath) -> bool:
        self._ensure_dir(path)
        return super().path_is_dir(path)

    def path_stat(self, path: PurePosixPath):
        self._ensure_file(path)
        self._ensure_dir(path)
        return super().path_stat(path)

    def path_iterdir(self, path: PurePosixPath) -> list[PurePosixPath]:
        remote = self._list_remote(str(path))
        if remote is None:
            return super().path_iterdir(path)
        self._insert_tree_dir(path)
        merged = {str(p): p for p in super().path_iterdir(path)}
        for name in remote:
            child = path / name.rstrip("/")
            merged.setdefault(str(child), child)
        return sorted(merged.values())

    def path_open(self, path: PurePosixPath, mode: str) -> MontyFileHandle:
        self._ensure_file(path)
        facts = parse_mode(mode)
        if facts.writable:
            self._ensure_dir(path.parent)
        existed = self._get_entry(path) is not None
        handle = super().path_open(path, mode)
        # The mode's open-time effect on the mount, the same
        # establishing op quickjs's shim and wasi's path_open dispatch:
        # 'w' truncates what exists and creates what does not, 'a'
        # creates what does not. Without it a bare open/close never
        # flushes (there is no delta), so the file either kept its old
        # bytes or never existed at all.
        if existed and facts.truncate:
            self._vfs.truncate(str(path))
        elif not existed and facts.create:
            self._vfs.create(str(path))
        return handle

    def path_read_text(self, path: PurePosixPath | MontyFileHandle) -> str:
        self._ensure_file(path_from_arg(path))
        return super().path_read_text(path)

    def path_read_bytes(self, path: PurePosixPath | MontyFileHandle) -> bytes:
        self._ensure_file(path_from_arg(path))
        return super().path_read_bytes(path)

    def path_write_text(self, path: PurePosixPath | MontyFileHandle,
                        data: str) -> int:
        self._ensure_dir(path_from_arg(path).parent)
        out = super().path_write_text(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_write_bytes(self, path: PurePosixPath | MontyFileHandle,
                         data: bytes) -> int:
        self._ensure_dir(path_from_arg(path).parent)
        out = super().path_write_bytes(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_append_text(self, path: PurePosixPath | MontyFileHandle,
                         data: str) -> int:
        self._ensure_file(path_from_arg(path))
        out = super().path_append_text(path, data)
        self._append_remote(path_from_arg(path), data.encode())
        return out

    def path_append_bytes(self, path: PurePosixPath | MontyFileHandle,
                          data: bytes) -> int:
        self._ensure_file(path_from_arg(path))
        out = super().path_append_bytes(path, data)
        self._append_remote(path_from_arg(path), bytes(data))
        return out

    def path_mkdir(self, path: PurePosixPath, parents: bool,
                   exist_ok: bool) -> None:
        """Create a directory on the mount, keeping pathlib's flags.

        `parents` rides through to the backend op, which takes it;
        `exist_ok` is answered here, since the op has no such argument
        and backends differ on whether creating an existing directory
        raises at all.

        `exist_ok` forgives an existing *directory* only. A file at the
        target still raises, which is pathlib's rule and monty's own
        base implementation's: `_is_file` is checked before `exist_ok`
        is consulted. The file is materialized first so one already
        read into the tree and one still only on the mount answer the
        same; the probe costs a read that `_missing` then caches.

        Args:
            path (PurePosixPath): the directory to create.
            parents (bool): create missing ancestors too.
            exist_ok (bool): stay quiet when it already exists.
        """
        self._ensure_dir(path.parent)
        if not self._vfs.wired:
            super().path_mkdir(path, parents, exist_ok)
            return
        self._ensure_file(path)
        entry = self._get_entry(path)
        if entry is not None and not isinstance(entry, dict):
            raise FileExistsError(FILE_EXISTS_MESSAGE.format(path=str(path)))
        if entry is not None or self._list_remote(str(path)) is not None:
            if exist_ok:
                self._insert_tree_dir(path)
                return
            raise FileExistsError(FILE_EXISTS_MESSAGE.format(path=str(path)))
        self._vfs.mkdir(str(path), parents)
        self._insert_tree_dir(path)

    def path_rmdir(self, path: PurePosixPath) -> None:
        self._ensure_dir(path)
        self._vfs.rmdir(str(path))
        super().path_rmdir(path)

    def path_rename(self, path: PurePosixPath, target: PurePosixPath) -> None:
        """Rename within one mount, refusing to cross mounts.

        The dispatcher picks the mount from the source alone and hands
        the destination to that same backend, which reads it against
        its own keyspace: a cross-mount rename would drop the source
        and write the target into the wrong store. EXDEV is what POSIX
        answers for a rename across filesystems, so the failure is the
        familiar one and the copy-and-delete workaround is the known
        one. Monty ships no `shutil`, so its own code has to write that
        fallback by hand; the runtimes with a real stdlib get it from
        `shutil.move`, which retries on exactly this errno.

        Args:
            path (PurePosixPath): the source path.
            target (PurePosixPath): the destination path.

        Raises:
            OSError: EXDEV when source and target live on different
                mounts.
        """
        self._ensure_file(path)
        self._ensure_dir(path)
        try:
            self._vfs.rename(str(path), str(target))
        except CrossMountError as exc:
            raise OSError(errno.EXDEV, EXDEV_MESSAGE, str(path), None,
                          str(target)) from exc
        super().path_rename(path, target)
        self._restamp(target)

    def _restamp(self, target: PurePosixPath) -> None:
        """Re-point a renamed file at the name it now has.

        monty 0.0.19's `path_rename` moves a file between directory
        dicts without updating the file's own `path`/`name`, which it
        does do for the directory branch (`_update_paths_recursive`).
        `path_unlink` then deletes by `file.name`, so renaming a.txt to
        b.txt and removing b.txt raises `KeyError: 'a.txt'`, which is
        not an OSError and so cannot be caught by guest code. On a
        mount the rename has already landed by then, leaving the
        backend ahead of the tree. Reproduces on a bare `OSAccess` with
        no mirage in the picture, so it belongs upstream; drop this once
        a release carries the fix.

        Args:
            target (PurePosixPath): the path the file now has.
        """
        entry = self._get_entry(target)
        if entry is None or isinstance(entry, dict):
            return
        entry.path = target
        entry.name = target.name

    def path_unlink(self, path: PurePosixPath) -> None:
        self._ensure_file(path)
        super().path_unlink(path)
        self._vfs.unlink(str(path))
