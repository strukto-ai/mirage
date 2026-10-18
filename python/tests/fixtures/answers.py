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
from mirage.types import MountMode, PathSpec
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow

Answer = Callable[..., Awaitable[Any]]


class Answers:
    """A dispatcher for one mount, each function it serves answered by a
    path-first callable; one it has no callable for is refused with
    ENOTSUP, as one the mount does not answer is. The mount's row names
    every function but ``stat``, ``readdir`` and ``read``, so a builder
    asks for it.

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
    files = Files(mount.rows, mount, ledger=False)
    ctx = Context(flags=flags, cwd=PathSpec.from_str_path("/"), vfs=files)
    token = set_mount_gate(mount.prefix, MountMode.WRITE)
    try:
        stdout, io = await generic(name).fn(
            None, list(paths), list(texts), ctx
        )
    finally:
        reset_mount_gate(token)
    return (await materialize(stdout) if stdout is not None else b""), io
