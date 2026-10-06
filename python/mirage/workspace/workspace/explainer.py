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

import dataclasses
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from mirage.context import reset_explaining, set_explaining
from mirage.ops import Ops
from mirage.policy import Explanation
from mirage.policy.errors import Explained

if TYPE_CHECKING:
    from mirage.workspace.workspace.workspace import Workspace

logger = logging.getLogger(__name__)


class Explainer:
    """A session's calls explained instead of run, under the session's
    own names: ``explain.shell(line)`` is ``session.shell(line)`` and
    ``explain.vfs.<op>(...)`` is ``session.vfs.<op>(...)``, each
    answering what the policies would decide.

    Nothing runs: no command, no backend or cache read, no grant spent
    and no question put to a host. A hide never surfaces: a path the
    session cannot see explains like any path no policy refuses.

    Args:
        ws (Workspace): the workspace the session lives in.
        session_id (str | None): the session; None for the default one.
        vfs (Ops): the session's op facade.
    """

    def __init__(
        self, ws: "Workspace", session_id: str | None, vfs: Ops
    ) -> None:
        self._ws = ws
        self._session_id = session_id
        self._vfs = vfs

    async def shell(self, line: str) -> list[Explanation]:
        """What a line would do: one explanation per command the gate
        reads, with every policy's answer and the line's placement
        (``Workspace.explain``).

        Args:
            line (str): the line, as the agent would type it.
        """
        return await self._ws.explain(line, self._session_id or "")

    @property
    def vfs(self) -> "VfsExplainer":
        """The session's file ops, explained."""
        return VfsExplainer(self._vfs)


class VfsExplainer:
    """``session.vfs`` explained: each op takes the arguments the real
    one does and walks the same door (the path resolved, links followed,
    hides, the mount mode, every policy), which stops at the op gate
    with what it would answer.

    An op the door answers before any policy is asked (a path that is
    hidden or missing, a rename across mounts) explains as an op no
    policy refuses: a dry run says what the policies decide, not whether
    the call would otherwise succeed, which is what keeps a hide from
    surfacing; for the same reason an op's explanation names no paths
    beyond the ``argv`` it was asked about, since what the door resolved
    a path to would tell a hidden one from a missing one. A rename passes
    two gates, its source and then its destination; its explanation is
    the first that refuses, with the answers of both.

    Args:
        vfs (Ops): the session's op facade.
    """

    def __init__(self, vfs: Ops) -> None:
        self._vfs = vfs

    async def read(
        self, path: str, offset: int = 0, size: int | None = None
    ) -> Explanation:
        """Explain ``session.vfs.read``.

        Args:
            path (str): the path.
            offset (int): where the read would start.
            size (int | None): how much it would read.
        """
        return await _dry(
            "read", (path,), lambda: self._vfs.read(path, offset, size)
        )

    async def write(self, path: str, data: bytes) -> Explanation:
        """Explain ``session.vfs.write``.

        Args:
            path (str): the path.
            data (bytes): what would be written.
        """
        return await _dry(
            "write", (path,), lambda: self._vfs.write(path, data)
        )

    async def append(self, path: str, data: bytes) -> Explanation:
        """Explain ``session.vfs.append``.

        Args:
            path (str): the path.
            data (bytes): what would be appended.
        """
        return await _dry(
            "append", (path,), lambda: self._vfs.append(path, data)
        )

    async def stat(self, path: str, *, nofollow: bool = False) -> Explanation:
        """Explain ``session.vfs.stat``.

        Args:
            path (str): the path.
            nofollow (bool): stat a link itself, not its target.
        """
        return await _dry(
            "stat", (path,), lambda: self._vfs.stat(path, nofollow=nofollow)
        )

    async def readdir(self, path: str) -> Explanation:
        """Explain ``session.vfs.readdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("readdir", (path,), lambda: self._vfs.readdir(path))

    async def exists(self, path: str) -> Explanation:
        """Explain ``session.vfs.exists``, judged as the stat it makes.

        Args:
            path (str): the path.
        """
        return await _dry("exists", (path,), lambda: self._vfs.stat(path))

    async def mkdir(self, path: str) -> Explanation:
        """Explain ``session.vfs.mkdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("mkdir", (path,), lambda: self._vfs.mkdir(path))

    async def rmdir(self, path: str) -> Explanation:
        """Explain ``session.vfs.rmdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("rmdir", (path,), lambda: self._vfs.rmdir(path))

    async def unlink(self, path: str) -> Explanation:
        """Explain ``session.vfs.unlink``.

        Args:
            path (str): the path.
        """
        return await _dry("unlink", (path,), lambda: self._vfs.unlink(path))

    async def rename(self, src: str, dst: str) -> Explanation:
        """Explain ``session.vfs.rename``.

        Args:
            src (str): the path moved.
            dst (str): where it would land.
        """
        return await _dry(
            "rename", (src, dst), lambda: self._vfs.rename(src, dst)
        )

    async def truncate(self, path: str, length: int) -> Explanation:
        """Explain ``session.vfs.truncate``.

        Args:
            path (str): the path.
            length (int): the length it would be cut to.
        """
        return await _dry(
            "truncate", (path,), lambda: self._vfs.truncate(path, length)
        )


async def _dry(
    op: str, argv: tuple[str, ...], call: Callable[[], Awaitable[Any]]
) -> Explanation:
    """Walk one op through its door as a dry run and say what its gates
    answered.

    Args:
        op (str): the op's name.
        argv (tuple[str, ...]): its paths, as given.
        call (Callable[[], Awaitable[Any]]): the op on the session's
            facade.

    Raises:
        RuntimeError: the op returned, so it ran past its gate, which
            no door may let it do.
    """
    trace: list[Explanation] = []
    token = set_explaining(trace)
    try:
        await call()
    except Explained:
        pass
    except OSError as exc:
        if trace:
            raise
        logger.debug("%s answered before its gate: %s", op, exc)
    else:
        raise RuntimeError(f"{op} ran past its gate in a dry run")
    finally:
        reset_explaining(token)
    if not trace:
        return Explanation(command=op, argv=argv)
    shown = next((e for e in trace if e.error), trace[-1])
    return dataclasses.replace(
        shown,
        command=op,
        argv=argv,
        paths=(),
        answers=tuple(a for e in trace for a in e.answers),
    )
