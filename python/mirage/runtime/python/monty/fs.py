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

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import PurePosixPath
from stat import S_ISREG
from typing import Any

from mirage.errors import FsCondition, classify
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import parse_mode
from mirage.runtime.open import apply_open
from mirage.runtime.python.monty.constants import (
    MAX_URANDOM_BYTES,
    NOT_A_LINK,
)
from mirage.runtime.python.monty.errors import guest_error
from mirage.runtime.python.monty.list import child_paths
from mirage.runtime.python.monty.loader import (
    AbstractOS,
    MontyFileHandle,
    path_from_arg,
)
from mirage.runtime.python.monty.stat import stat_result
from mirage.runtime.types import VFSStat


@contextmanager
def _as_guest(path: str, target: str | None = None) -> Iterator[None]:
    """Re-raise a mount failure the way guest CPython raises it.

    A backend words its refusals its own way; a guest catches the
    builtin and may print its message. Every named condition converts,
    so a non-empty rmdir is ``OSError`` errno 39 wherever it happened,
    and a failure the vocabulary does not name is EIO, as a kernel
    reports a device that failed (the engine knows only builtin types,
    so a backend's own exception would reach the guest as
    ``RuntimeError``).

    Args:
        path (str): the path the operation names.
        target (str | None): a rename's destination.
    """
    try:
        yield
    except Exception as exc:
        condition = classify(exc) or FsCondition.EIO
        raise guest_error(condition, path, target) from exc


class MontyFs(AbstractOS):
    """Monty's OS callbacks: every path a guest names is the workspace's.

    This is monty's tier of the interception taxonomy: the engine hands
    the interpreter a host OS object and calls its methods, so mirage
    implements that object rather than hooking a syscall layer. Every
    path goes to the file adapter, and nothing is kept aside: structure is
    open (a listing, whether a name is a directory or a link) and
    content goes only through the runtime's view (``RuntimeFiles.serves``:
    the announced mounts and what a link reaches), so a guest lists what
    a shell lists and reads and writes nothing the view withholds. The
    environment, the clocks and ``urandom`` are the engine's own.

    Monty hands the callbacks whole-file calls: an open, then reads of the
    whole file and appends of each new write. So an open applies its
    mode's effect on the mount (``apply_open``) and nothing else, and
    each write after it ships only its own bytes.

    The callbacks are synchronous, so the file API's hop parks the
    tokio worker for the whole I/O wait. That caps concurrent
    I/O-waiting runs at Monty's worker pool size, which is the core
    count by default; TOKIO_WORKER_THREADS raises it, and parked
    workers cost stack pages, not CPU (measured: 100 concurrent 1s-I/O
    runs finish in ~2s at 64 workers versus ~8s at 14).

    Args:
        files (RuntimeFiles | None): the execution's file API, built with
            ``RuntimeFiles.of(context)``; None outside a workspace, where
            every path is out of view.
        environ (dict[str, str]): the guest's environment.
    """

    def __init__(
        self, files: RuntimeFiles | None, environ: dict[str, str]
    ) -> None:
        self.max_urandom_bytes = MAX_URANDOM_BYTES
        self._environ = dict(environ)
        self._files = files

    def getenv(self, key: str, default: str | None = None) -> str | None:
        return self._environ.get(key, default)

    def get_environ(self) -> dict[str, str]:
        return self._environ

    def path_absolute(self, path: PurePosixPath) -> str:
        # '/' is the working directory, as monty's own tree answers.
        return str(PurePosixPath("/") / path)

    def path_resolve(self, path: PurePosixPath) -> str:
        return self.path_absolute(path)

    def _files_for(self, path: PurePosixPath) -> RuntimeFiles:
        """The file adapter for a content call on `path`, in the view only.

        Args:
            path (PurePosixPath): the guest path.
        """
        files = self._files
        if files is None or not files.serves(str(path)):
            raise guest_error(FsCondition.ENOENT, str(path))
        return files

    def _structure(self, path: PurePosixPath) -> RuntimeFiles:
        """The file adapter for a structural question, asked of any path.

        Args:
            path (PurePosixPath): the guest path.
        """
        if self._files is None:
            raise guest_error(FsCondition.ENOENT, str(path))
        return self._files

    def _row(self, path: PurePosixPath) -> VFSStat | None:
        if self._files is None:
            return None
        with _as_guest(str(path)):
            return self._files.view_stat(str(path))

    def path_exists(self, path: PurePosixPath) -> bool:
        return self._row(path) is not None

    def path_is_file(self, path: PurePosixPath) -> bool:
        row = self._row(path)
        return row is not None and S_ISREG(row.mode)

    def path_is_dir(self, path: PurePosixPath) -> bool:
        row = self._row(path)
        return row is not None and row.is_dir

    def path_is_symlink(self, path: PurePosixPath) -> bool:
        """Whether the name plane holds a symlink at `path`, via readlink.

        Creation stays out of reach, because the engine has no symlink
        verb to serve.

        Args:
            path (PurePosixPath): the guest path to test.
        """
        if self._files is None:
            return False
        with _as_guest(str(path)):
            try:
                self._files.readlink(str(path))
            except Exception as caught:
                if classify(caught) not in NOT_A_LINK:
                    raise
                return False
        return True

    def path_stat(self, path: PurePosixPath) -> Any:
        """The path's stat: the mount's own row, so a chmod shows.

        Args:
            path (PurePosixPath): the guest path to stat.
        """
        row = self._row(path)
        if row is None:
            raise guest_error(FsCondition.ENOENT, str(path))
        return stat_result(row)

    def path_iterdir(self, path: PurePosixPath) -> list[PurePosixPath]:
        files = self._structure(path)
        with _as_guest(str(path)):
            entries = files.readdir(str(path), classify=False)
        return child_paths(path, [entry.path for entry in entries])

    def path_open(self, path: PurePosixPath, mode: str) -> MontyFileHandle:
        # Built first: a malformed mode must raise before any effect
        # lands on the mount.
        handle = MontyFileHandle(str(path), mode)
        files = self._files_for(path)
        with _as_guest(str(path)):
            apply_open(files, str(path), parse_mode(mode))
        return handle

    def path_read_text(self, path: PurePosixPath | MontyFileHandle) -> str:
        return self.path_read_bytes(path).decode()

    def path_read_bytes(self, path: PurePosixPath | MontyFileHandle) -> bytes:
        target = path_from_arg(path)
        files = self._files_for(target)
        with _as_guest(str(target)):
            return files.read(str(target))

    def path_write_text(
        self, path: PurePosixPath | MontyFileHandle, data: str
    ) -> int:
        self.path_write_bytes(path, data.encode())
        return len(data)

    def path_write_bytes(
        self, path: PurePosixPath | MontyFileHandle, data: bytes
    ) -> int:
        target = path_from_arg(path)
        files = self._files_for(target)
        with _as_guest(str(target)):
            files.write(str(target), bytes(data))
        return len(data)

    def path_append_text(
        self, path: PurePosixPath | MontyFileHandle, data: str
    ) -> int:
        self.path_append_bytes(path, data.encode())
        return len(data)

    def path_append_bytes(
        self, path: PurePosixPath | MontyFileHandle, data: bytes
    ) -> int:
        """Send only the appended bytes; monty hands an append nothing else.

        Re-sending everything written so far turns a write loop
        quadratic, so a mount with its own append op carries just these
        bytes, and the adapter falls back to a whole-file write only for
        the mount without one.

        Args:
            path (PurePosixPath | MontyFileHandle): the file.
            data (bytes): only the newly appended bytes.
        """
        target = path_from_arg(path)
        files = self._files_for(target)
        with _as_guest(str(target)):
            files.append(str(target), bytes(data))
        return len(data)

    def path_mkdir(
        self, path: PurePosixPath, parents: bool, exist_ok: bool
    ) -> None:
        """Create a directory, keeping pathlib's flags.

        `parents` rides through to the backend op, which takes it;
        `exist_ok` is answered here, since the op has no such argument
        and backends differ on whether creating an existing directory
        raises at all. It forgives an existing directory only: a file
        at the target still raises, pathlib's own rule.

        Args:
            path (PurePosixPath): the directory to create.
            parents (bool): create missing ancestors too.
            exist_ok (bool): stay quiet when it already exists.
        """
        row = self._row(path)
        if row is not None and not row.is_dir:
            raise guest_error(FsCondition.EEXIST, str(path))
        if row is not None:
            if exist_ok:
                return
            raise guest_error(FsCondition.EEXIST, str(path))
        files = self._files_for(path)
        with _as_guest(str(path)):
            files.mkdir(str(path), parents=parents)

    def path_rmdir(self, path: PurePosixPath) -> None:
        files = self._files_for(path)
        with _as_guest(str(path)):
            files.rmdir(str(path))

    def path_unlink(self, path: PurePosixPath) -> None:
        files = self._files_for(path)
        with _as_guest(str(path)):
            files.unlink(str(path))

    def path_rename(self, path: PurePosixPath, target: PurePosixPath) -> None:
        """Rename within one mount; across mounts it is EXDEV.

        The dispatcher picks the mount from the source alone, so the
        adapter refuses a pair on different mounts, and EXDEV is POSIX's
        answer for a rename across filesystems. Monty ships no `shutil`,
        so guest code writes the copy-and-delete fallback by hand, and
        the errno is what tells it to.

        Args:
            path (PurePosixPath): the source path.
            target (PurePosixPath): the destination path.
        """
        files = self._files_for(path)
        with _as_guest(str(path), str(target)):
            files.rename(str(path), str(target))
