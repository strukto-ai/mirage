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
from pathlib import Path

from mirage.runtime.wasm.abi import FT_DIR, FT_REG
from mirage.runtime.wasm.types import GuestStat


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
        self._root = root

    def target(self, path: str) -> Path:
        """The host path a guest path names, present or not.

        Args:
            path (str): guest-absolute path.
        """
        rel = path.lstrip("/")
        return self._root / rel if rel else self._root

    def has(self, path: str) -> bool:
        """Whether this build actually holds `path`.

        Args:
            path (str): guest-absolute path.
        """
        return path == "/" or self.target(path).exists()

    def stat(self, path: str) -> GuestStat:
        """Stat a build path.

        Args:
            path (str): guest-absolute path.
        """
        host = self.target(path)
        st = os.stat(host)
        return GuestStat(is_dir=host.is_dir(),
                         size=st.st_size,
                         mtime_ns=st.st_mtime_ns)

    def read(self, path: str) -> bytes:
        """Read a build file.

        Args:
            path (str): guest-absolute path.
        """
        return self.target(path).read_bytes()

    def readdir(self, path: str) -> list[tuple[str, int]]:
        """List a build directory as (name, preview1 filetype) pairs.

        Args:
            path (str): guest-absolute path.
        """
        entries = []
        for entry in os.scandir(self.target(path)):
            entries.append((entry.name, FT_DIR if entry.is_dir() else FT_REG))
        return sorted(entries)
