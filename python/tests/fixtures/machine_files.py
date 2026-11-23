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


import itertools
import posixpath
import shlex

from mirage import MountMode, Workspace
from mirage.accessor.machine import MachineAccessor
from mirage.core.posix.constants import ENTRY_FORMAT
from mirage.runtime.types import RunAnswer
from mirage.types import PathSpec
from mirage.vfs.machine.config import MachineVFSConfig
from tests.fixtures.machine import ScriptedMachine, failed, ok, table_of

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


def holding(*paths: str, written: int = 1700000000):
    """An answer holding ``paths`` as files and every other stat missing.

    Args:
        paths (str): the files it holds.
        written (int): when they were written, in epoch seconds.
    """
    entry = f"f 644 3 {written} 1700000001 0 50 1 0 \0".encode()

    def answer(line, data):
        if "-maxdepth 0" in line:
            if any(f"'{p}'" in line for p in paths):
                return ok(entry)
            return failed(b"find: 'x': No such file or directory\n")
        return ok(b"hi\n")

    return answer


class FakeFiles:
    """One machine's own files, answering the lines a machine mount sends
    as its POSIX tools would.

    Every write stamps its file from one clock all the machines share,
    so the copy written last is the same whichever machine is asked.

    Args:
        files (dict[str, bytes] | None): the files by absolute path.
        programs (tuple[str, ...]): the programs ``command -v`` finds.
    """

    clock = itertools.count(1)

    def __init__(
        self,
        files: dict[str, bytes] | None = None,
        programs: tuple[str, ...] = (),
    ) -> None:
        self.files = dict(files or {})
        self.written: dict[str, int] = {}
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

    def _stamp(self, path: str) -> None:
        self.written[path] = next(FakeFiles.clock)

    def _row(self, path: str, rel: str) -> bytes:
        at = self.written.get(path, 0)
        if path in self.dirs:
            return f"d 755 4096 {at} 0 0 0 2 8 {rel}\0".encode()
        size = len(self.files[path])
        return f"f 644 {size} {at} 0 0 0 1 0 {rel}\0".encode()

    def _move_folder(self, src: str, dst: str) -> RunAnswer:
        if posixpath.dirname(dst) not in self.dirs:
            return self._missing("mv", dst)
        for name in sorted(self.dirs):
            if name == src or name.startswith(src + "/"):
                self.dirs.discard(name)
                self.dirs.add(dst + name[len(src) :])
        for name in sorted(self.files):
            if name.startswith(src + "/"):
                self.files[dst + name[len(src) :]] = self.files.pop(name)
        for name in sorted(self.written):
            if name == src or name.startswith(src + "/"):
                self.written[dst + name[len(src) :]] = self.written.pop(name)
        return ok()

    def _missing(self, tool: str, path: str) -> RunAnswer:
        return failed(
            f"{tool}: '{path}': No such file or directory\n".encode()
        )

    def _one(self, words: list[str], data: bytes | None) -> RunAnswer:
        if words[0].startswith("PATH="):
            words = words[1:]
        if words[:2] == ["command", "-v"]:
            return ok() if words[2] in self.programs else failed(b"")
        if words[:3] == ["readlink", "-f", "--"]:
            real = self._real(words[3])
            if posixpath.dirname(real) not in self.dirs:
                return failed(b"")
            return ok(f"{real}\n".encode())
        if words[:4] == ["env", "LC_ALL=C", "find", "-L"]:
            assert words[-2:] == ["-printf", ENTRY_FORMAT], words
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
            self._stamp(path)
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
            if words[0] == "mv" and src in self.dirs:
                return self._move_folder(src, dst)
            if src not in self.files:
                return self._missing(words[0], src)
            if posixpath.dirname(dst) not in self.dirs:
                return self._missing(words[0], dst)
            self.files[dst] = self.files[src]
            self.written[dst] = self.written.get(src, 0)
            if words[0] == "mv":
                del self.files[src]
            else:
                self._stamp(dst)
            return ok()
        self.ran.append(shlex.join(words))
        return ok(b"ran\n")


TOOLS = ("ls", "cat", "grep", "wc")


def one(files: FakeFiles, mounts=None, **kwargs) -> Workspace:
    """A workspace running its programs on one machine, ``box``, that
    holds ``files``; writable unless ``mode`` says otherwise.

    Args:
        files (FakeFiles): the machine's files.
        mounts (dict | None): the workspace's mounts.
        kwargs: the workspace's other options.
    """
    return Workspace(
        mounts or {},
        mode=kwargs.pop("mode", MountMode.WRITE),
        machines={"box": ScriptedMachine("box", files.answer)},
        **kwargs,
    )


async def out(ws: Workspace, line: str) -> str:
    """What a line writes to stdout.

    Args:
        ws (Workspace): the workspace.
        line (str): the line it runs.
    """
    return await (await ws.shell(line)).stdout_str()


def two(a: FakeFiles, b: FakeFiles, **kwargs) -> Workspace:
    """A writable workspace running its programs on two machines, ``a``
    then ``b``.

    Args:
        a (FakeFiles): the first machine's files.
        b (FakeFiles): the second machine's files.
        kwargs: the workspace's other options, ``mounts`` among them.
    """
    return Workspace(
        kwargs.pop("mounts", {}),
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
        **kwargs,
    )


async def run(ws: Workspace, line: str) -> tuple[int, str, str]:
    """A line's exit code, stdout and stderr.

    Args:
        ws (Workspace): the workspace.
        line (str): the line it runs.
    """
    result = await ws.shell(line)
    return (
        result.exit_code,
        await result.stdout_str(),
        await result.stderr_str(),
    )
