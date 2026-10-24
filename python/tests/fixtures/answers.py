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

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from mirage.commands.builtin.generic_bind import generic
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.errors.fs import enotsup
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers

Answer = Callable[..., Awaitable[Any]]


class Answers:
    """A dispatcher for one mount, each function it serves answered by a
    path-first callable; one it has no callable for is refused with
    ENOTSUP, as one the mount does not answer is, except
    ``before_full_walk``, which passes as it does on a mount with no
    ``walk_limit``. The mount's row names every function but
    ``stat``, ``readdir`` and ``read``, so a builder asks for it.

    Args:
        prefix (str): the mount's prefix.
        below (Sequence[str]): the prefixes of mounts nested below it.
        **answers (Answer): the callables, by function name.
    """

    def __init__(
        self, prefix: str = "/", below: Sequence[str] = (), **answers: Answer
    ) -> None:
        self.prefix = prefix
        self.answers = answers
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        calls = frozenset(set(answers) - {"stat", "readdir", "read"})
        self.rows = [
            MountRow(prefix, "ram", MountMode.WRITE, calls=calls),
            *(MountRow(p, "ram", MountMode.WRITE) for p in below),
        ]

    async def __call__(
        self, name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        self.calls.append((name, path.virtual, kwargs))
        answer = self.answers.get(name)
        if answer is None and name == "before_full_walk":
            return None, IOResult()
        if answer is None:
            raise enotsup("ram", name, path)
        drop = ("nofollow", "filetype", "stream")
        taken = {k: v for k, v in kwargs.items() if k not in drop}
        return await answer(path, **taken), IOResult()


async def run_generic(
    name: str,
    mount: Answers,
    paths: Sequence[PathSpec],
    texts: Sequence[str] = (),
    **flags: Any,
) -> tuple[bytes, IOResult]:
    """Run the generic ``name`` on ``mount`` as the mount runs it, its
    output read whole.

    Args:
        name (str): the command.
        mount (Answers): the mount it runs on.
        paths (Sequence[PathSpec]): its path operands.
        texts (Sequence[str]): its text operands.
        **flags (Any): its parsed flags.
    """
    files = Files(mount, readers(mount.rows), ledger=False)
    ctx = Context(flags=flags, cwd=PathSpec.from_str_path("/"), vfs=files)
    token = set_mount_gate(mount.prefix, MountMode.WRITE)
    try:
        stdout, io = await generic(name).fn(
            None, list(paths), list(texts), ctx
        )
    finally:
        reset_mount_gate(token)
    return (await materialize(stdout) if stdout is not None else b""), io


def memory_tree(files: dict[str, bytes], dirs: set[str] | None = None):
    """Build read callbacks over an in-memory file tree.

    Args:
        files (dict[str, bytes]): file contents keyed by virtual path.
        dirs (set[str] | None): additional directories; parents are inferred.
    """

    inferred_dirs = set(dirs) if dirs is not None else set()
    for f in files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)
    inferred_dirs.add("/")

    async def readdir(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = spec.virtual.rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in files:
            if f.startswith(prefix):
                rest = f[len(prefix) :]
                child = rest.split("/")[0]
                children.add(prefix + child)
        for d in inferred_dirs:
            if d == p:
                continue
            if d.startswith(prefix):
                rest = d[len(prefix) :]
                child = rest.split("/")[0]
                children.add(prefix + child)
        return sorted(children)

    async def stat(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = spec.virtual
        if p in files:
            return FileStat(
                name=p.rsplit("/", 1)[-1] or p,
                size=len(files[p]),
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(
                name=p.rsplit("/", 1)[-1] or "/", type=FileType.DIRECTORY
            )
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

    async def read_stream(path):
        data = await read_bytes(path)
        yield data

    return readdir, stat, read_bytes, read_stream
