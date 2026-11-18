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


import posixpath
import shlex

from mirage.accessor.machine import MachineAccessor
from mirage.core.posix.constants import TREE_FORMAT
from mirage.runtime.types import RunAnswer
from mirage.types import PathSpec
from mirage.vfs.machine.config import MachineVFSConfig
from tests.fixtures.machine import failed, ok, table_of

ROW = b"f 644 3 1700000000 1700000001 0 50 1 0 \0"
DIR = b"d 755 4096 1700000000 1700000001 0 0 2 8 \0"


def bound(*handles, root="/tmp", **config):
    accessor = MachineAccessor(MachineVFSConfig(root=root, **config))
    accessor.bind_machines(table_of(*handles), handles[0].name)
    return accessor


def spec(path: str, prefix: str = "/tmp") -> PathSpec:
    """A path on a mount at ``prefix``; ``path`` is slash-led."""
    return PathSpec(
        virtual=prefix + path,
        directory=prefix + path.rsplit("/", 1)[0],
        vfs_path=path.lstrip("/"),
        raw_path=prefix + path,
    )


def holding(*paths: str):
    """An answer holding ``paths`` as files and every other stat missing."""

    def answer(line, data):
        if "-maxdepth 0" in line:
            if any(f"'{p}'" in line for p in paths):
                return ok(ROW)
            return failed(b"find: 'x': No such file or directory\n")
        return ok(b"hi\n")

    return answer


class FakeFiles:
    """One machine's own files, answering the lines a machine mount sends
    as its POSIX tools would.

    Args:
        files (dict[str, bytes] | None): the files by absolute path.
        programs (tuple[str, ...]): the programs ``command -v`` finds.
    """

    def __init__(
        self,
        files: dict[str, bytes] | None = None,
        programs: tuple[str, ...] = (),
    ) -> None:
        self.files = dict(files or {})
        self.dirs = {"/", "/tmp", "/dev", "/dev/shm"}
        for path in self.files:
            while (path := posixpath.dirname(path)) not in self.dirs:
                self.dirs.add(path)
        self.programs = set(programs)
        self.ran: list[str] = []
        self.links: dict[str, str] = {}

    def _real(self, path: str) -> str:
        for link, target in self.links.items():
            if path == link or path.startswith(link + "/"):
                return target + path[len(link) :]
        return path

    def answer(self, line: str, data: bytes | None) -> RunAnswer:
        result = ok()
        for part in line.split(" && "):
            result = self._one(shlex.split(part), data)
            if result.exit_code:
                break
        return result

    def _row(self, path: str, rel: str) -> bytes:
        if path in self.dirs:
            return f"d 755 4096 0 0 0 0 2 8 {rel}\0".encode()
        size = len(self.files[path])
        return f"f 644 {size} 0 0 0 0 1 0 {rel}\0".encode()

    def _missing(self, tool: str, path: str) -> RunAnswer:
        return failed(
            f"{tool}: '{path}': No such file or directory\n".encode()
        )

    def _one(self, words: list[str], data: bytes | None) -> RunAnswer:
        if words[:2] == ["command", "-v"]:
            return ok() if words[2] in self.programs else failed(b"")
        if words[:3] == ["readlink", "-f", "--"]:
            real = self._real(words[3])
            if posixpath.dirname(real) not in self.dirs:
                return failed(b"")
            return ok(f"{real}\n".encode())
        if words[:4] == ["env", "LC_ALL=C", "find", "-L"]:
            assert words[-2:] == ["-printf", TREE_FORMAT], words
            path = self._real(words[4])
            depth = int(words[6]) if words[5] == "-maxdepth" else None
            if any(path.startswith(f + "/") for f in self.files):
                return failed(f"find: '{path}': Not a directory\n".encode())
            if path not in self.dirs and path not in self.files:
                return self._missing("find", path)
            out = self._row(path, "")
            under = path.rstrip("/") + "/"
            for child in sorted({*self.dirs, *self.files}):
                rel = child[len(under) :] if child.startswith(under) else ""
                if rel and child != path and (depth is None or "/" not in rel):
                    if depth != 0:
                        out += self._row(child, rel)
            return ok(out)
        if words[:2] == ["cat", "--"]:
            real = self._real(words[2])
            if real not in self.files:
                return self._missing("cat", words[2])
            return ok(self.files[real])
        if words[0] in ("cat", ":") and words[1] in (">", ">>"):
            path = words[2]
            if posixpath.dirname(path) not in self.dirs:
                return self._missing("sh", path)
            old = self.files.get(path, b"") if words[1] == ">>" else b""
            self.files[path] = old + (data or b"")
            return ok()
        if words[0] == "mkdir":
            path = words[-1]
            if posixpath.dirname(path) not in self.dirs and "-p" not in words:
                return self._missing("mkdir", path)
            while path not in self.dirs:
                self.dirs.add(path)
                path = posixpath.dirname(path)
            return ok()
        if words[0] == "rm":
            path = words[-1]
            if path in self.dirs and "-r" in words:
                for name in [*self.files, *self.dirs]:
                    if name == path or name.startswith(path + "/"):
                        self.files.pop(name, None)
                        self.dirs.discard(name)
                return ok()
            if path not in self.files:
                return self._missing("rm", path)
            del self.files[path]
            return ok()
        if words[0] == "rmdir":
            path = words[-1]
            if path not in self.dirs:
                return self._missing("rmdir", path)
            if any(
                n.startswith(path + "/") for n in [*self.files, *self.dirs]
            ):
                return failed(
                    f"rmdir: failed to remove '{path}': Directory not empty\n".encode()
                )
            self.dirs.discard(path)
            return ok()
        if words[0] in ("mv", "cp"):
            src, dst = words[-2], words[-1]
            if src not in self.files:
                return self._missing(words[0], src)
            if posixpath.dirname(dst) not in self.dirs:
                return self._missing(words[0], dst)
            self.files[dst] = self.files[src]
            if words[0] == "mv":
                del self.files[src]
            return ok()
        self.ran.append(shlex.join(words))
        return ok(b"ran\n")
