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
import posixpath
from pathlib import Path

from mirage.errors.fs import eacces
from mirage.runtime.types import VFSStat
from mirage.runtime.wasm.constants import FT_DIR, FT_REG


class BuildDir:
    """The interpreter's own files, served read-only.

    A wasm guest is a whole interpreter, so `python.wasm` needs its
    stdlib somewhere it can read. This is that half of the guest's
    filesystem: local host files, no workspace op, no event loop hop.

    Read-only is not a permission model, it is the guest's own build:
    letting a script edit the interpreter it is running inside would
    change what the next run executes. Mutations belong to the mounts,
    which is the other half.
    """

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def target(self, path: str) -> Path:
        """The host path a guest path names, present or not.

        Args:
            path (str): guest-absolute path.
        """
        rel = posixpath.normpath("/" + path.lstrip("/")).lstrip("/")
        target = (self._root / rel).resolve()
        if not target.is_relative_to(self._root):
            raise eacces(path)
        return target

    def _empty_extensions(self, path: str) -> bool:
        target = self.target(path)
        return (
            target.name == "lib-dynload"
            and target.parent.name.startswith("python3.")
            and target.parent.is_dir()
            and not target.exists()
        )

    def has(self, path: str) -> bool:
        """Whether this build actually holds `path`.

        Args:
            path (str): guest-absolute path.
        """
        return (
            path == "/"
            or self._empty_extensions(path)
            or self.target(path).exists()
        )

    def stat(self, path: str) -> VFSStat:
        """Stat a build path.

        The host's own st_mode is reported as it stands, type bits
        included: these are real files on this machine, so there is
        nothing to synthesize.

        Args:
            path (str): guest-absolute path.
        """
        if self._empty_extensions(path):
            return VFSStat(size=0, is_dir=True, mode=0o40555)
        host = self.target(path)
        st = os.stat(host)
        return VFSStat(
            size=st.st_size,
            is_dir=host.is_dir(),
            mode=st.st_mode,
            mtime_ns=st.st_mtime_ns,
        )

    def read(
        self, path: str, *, offset: int = 0, size: int | None = None
    ) -> bytes:
        """Read a build file, or a range of it.

        Args:
            path (str): guest-absolute path.
            offset (int): where the range starts.
            size (int | None): its length; None reads to the end.
        """
        with self.target(path).open("rb") as f:
            f.seek(offset)
            return f.read(-1 if size is None else size)

    def readdir(self, path: str) -> list[tuple[str, int]]:
        """List a build directory as (name, preview1 filetype) pairs.

        Args:
            path (str): guest-absolute path.
        """
        if self._empty_extensions(path):
            return []
        entries = []
        for entry in os.scandir(self.target(path)):
            entries.append((entry.name, FT_DIR if entry.is_dir() else FT_REG))
        return sorted(entries)
