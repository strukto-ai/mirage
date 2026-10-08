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
from typing import Any

from mirage.context import reset_explaining, set_explaining
from mirage.policy import ShellExplanation, VfsExplanation
from mirage.policy.errors import Explained
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)


class Explainer:
    """A session's calls explained instead of run, under the session's
    own names: ``explain.shell(line)`` is ``session.shell(line)`` and
    ``explain.vfs.<call>(...)`` is ``session.vfs.<call>(...)``, each
    answering what the policies would decide.

    Nothing runs: no command, no backend or cache read, no grant spent
    and no question put to a host. A policy deciding the call reads what
    it reads for real, but changes nothing: its own writes are refused
    and its own refused reads record no question. A hide never surfaces:
    a path the session cannot see explains like any path no policy
    refuses.

    Args:
        explain (Callable[[str, str], Awaitable[ShellExplanation]]): the
            workspace's line explainer, ``Workspace.explain``.
        session_id (str | None): the session; None for the default one.
        vfs (Files): the session's VFS facade.
    """

    def __init__(
        self,
        explain: Callable[[str, str], Awaitable[ShellExplanation]],
        session_id: str | None,
        vfs: Files,
    ) -> None:
        self._explain = explain
        self._session_id = session_id
        self._vfs = vfs

    async def shell(self, line: str) -> ShellExplanation:
        """What a line would do: its verdict, where it would run and
        every command in it, as a tree (``Workspace.explain``).

        Args:
            line (str): the line, as the agent would type it.
        """
        return await self._explain(line, self._session_id or "")

    @property
    def vfs(self) -> "VfsExplainer":
        """The session's VFS calls, explained."""
        return VfsExplainer(self._vfs)


class VfsExplainer:
    """``session.vfs`` explained: each VFS call (the POSIX-shaped calls:
    ``read``, ``pwrite``, ``rename``, ``setxattr``, ...) takes the
    arguments the real one does and walks the same door (the path
    resolved, links followed, hides, the mount mode, every policy),
    which stops at the gate with what it would answer.

    A call the door answers before any policy is asked (a path that is
    hidden or missing, a rename across mounts) explains as a call no
    policy refuses: a dry run says what the policies decide, not whether
    the call would otherwise succeed, which is what keeps a hide from
    surfacing; for the same reason an explanation names no paths beyond
    the ones it was asked about, since what the door resolved a path to
    would tell a hidden one from a missing one. A rename passes
    two gates, its source and then its destination; its explanation is
    the first that refuses, with the answers of both. ``list_files``
    is judged at its listing: the entries it would then stat are named
    only by the listing, a read a dry run does not make. A restore's
    pending drift checks are no policy's answer either: the dry run
    leaves them to the first call that runs, so a policy reading while it
    decides reads the restored state.

    Args:
        vfs (Files): the session's VFS facade.
    """

    def __init__(self, vfs: Files) -> None:
        self._vfs = vfs

    async def read(
        self, path: str, offset: int = 0, size: int | None = None
    ) -> VfsExplanation:
        """Explain ``session.vfs.read``.

        Args:
            path (str): the path.
            offset (int): where the read would start.
            size (int | None): how much it would read.
        """
        return await _dry(
            "read", (path,), lambda: self._vfs.read(path, offset, size)
        )

    async def write(self, path: str, data: bytes) -> VfsExplanation:
        """Explain ``session.vfs.write``.

        Args:
            path (str): the path.
            data (bytes): what would be written.
        """
        return await _dry(
            "write", (path,), lambda: self._vfs.write(path, data)
        )

    async def append(self, path: str, data: bytes) -> VfsExplanation:
        """Explain ``session.vfs.append``.

        Args:
            path (str): the path.
            data (bytes): what would be appended.
        """
        return await _dry(
            "append", (path,), lambda: self._vfs.append(path, data)
        )

    async def stat(
        self, path: str, *, nofollow: bool = False
    ) -> VfsExplanation:
        """Explain ``session.vfs.stat``.

        Args:
            path (str): the path.
            nofollow (bool): stat a link itself, not its target.
        """
        return await _dry(
            "stat", (path,), lambda: self._vfs.stat(path, nofollow=nofollow)
        )

    async def readdir(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.readdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("readdir", (path,), lambda: self._vfs.readdir(path))

    async def exists(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.exists``, judged as the stat it makes.

        Args:
            path (str): the path.
        """
        return await _dry("exists", (path,), lambda: self._vfs.stat(path))

    async def is_dir(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.is_dir``, judged as the stat it makes.

        Args:
            path (str): the path.
        """
        return await _dry("is_dir", (path,), lambda: self._vfs.stat(path))

    async def is_file(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.is_file``, judged as the stat it makes.

        Args:
            path (str): the path.
        """
        return await _dry("is_file", (path,), lambda: self._vfs.stat(path))

    async def cat(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.cat``, judged as the read it makes.

        Args:
            path (str): the path.
        """
        return await _dry("cat", (path,), lambda: self._vfs.read(path))

    async def list_files(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.list_files``, judged as the readdir it
        makes; the entries it would then stat are named only by that
        read, which a dry run does not make.

        Args:
            path (str): the directory.
        """
        return await _dry(
            "list_files", (path,), lambda: self._vfs.readdir(path)
        )

    async def pwrite(
        self, path: str, data: bytes, offset: int
    ) -> VfsExplanation:
        """Explain ``session.vfs.pwrite``.

        Args:
            path (str): the path.
            data (bytes): what would be written.
            offset (int): where it would land.
        """
        return await _dry(
            "pwrite", (path,), lambda: self._vfs.pwrite(path, data, offset)
        )

    async def create(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.create``.

        Args:
            path (str): the file it would create.
        """
        return await _dry("create", (path,), lambda: self._vfs.create(path))

    async def symlink(self, path: str, target: str) -> VfsExplanation:
        """Explain ``session.vfs.symlink``.

        Args:
            path (str): where the link would be made.
            target (str): what it would point to.
        """
        return await _dry(
            "symlink", (path,), lambda: self._vfs.symlink(path, target)
        )

    async def readlink(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.readlink``.

        Args:
            path (str): the link.
        """
        return await _dry(
            "readlink", (path,), lambda: self._vfs.readlink(path)
        )

    async def setattr(
        self,
        path: str,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
        nofollow: bool = False,
    ) -> VfsExplanation:
        """Explain ``session.vfs.setattr``.

        Args:
            path (str): the path.
            mode (int | None): permission bits it would set.
            uid (int | str | None): owner it would set.
            gid (int | str | None): group it would set.
            atime (str | None): ISO access time it would set.
            mtime (str | None): ISO modification time it would set.
            nofollow (bool): set a link entry's own attributes.
        """
        return await _dry(
            "setattr",
            (path,),
            lambda: self._vfs.setattr(
                path,
                mode=mode,
                uid=uid,
                gid=gid,
                atime=atime,
                mtime=mtime,
                nofollow=nofollow,
            ),
        )

    async def getxattr(
        self, path: str, name: str, *, nofollow: bool = False
    ) -> VfsExplanation:
        """Explain ``session.vfs.getxattr``.

        Args:
            path (str): the path.
            name (str): the attribute.
            nofollow (bool): read a link entry's own attributes.
        """
        return await _dry(
            "getxattr",
            (path,),
            lambda: self._vfs.getxattr(path, name, nofollow=nofollow),
        )

    async def listxattr(
        self, path: str, *, nofollow: bool = False
    ) -> VfsExplanation:
        """Explain ``session.vfs.listxattr``.

        Args:
            path (str): the path.
            nofollow (bool): list a link entry's own attributes.
        """
        return await _dry(
            "listxattr",
            (path,),
            lambda: self._vfs.listxattr(path, nofollow=nofollow),
        )

    async def setxattr(
        self,
        path: str,
        name: str,
        value: bytes,
        *,
        create: bool = False,
        replace: bool = False,
        nofollow: bool = False,
    ) -> VfsExplanation:
        """Explain ``session.vfs.setxattr``.

        Args:
            path (str): the path.
            name (str): the attribute.
            value (bytes): what it would store.
            create (bool): only if the attribute is not set.
            replace (bool): only if the attribute is set.
            nofollow (bool): set on a link entry itself.
        """
        return await _dry(
            "setxattr",
            (path,),
            lambda: self._vfs.setxattr(
                path,
                name,
                value,
                create=create,
                replace=replace,
                nofollow=nofollow,
            ),
        )

    async def removexattr(
        self, path: str, name: str, *, nofollow: bool = False
    ) -> VfsExplanation:
        """Explain ``session.vfs.removexattr``.

        Args:
            path (str): the path.
            name (str): the attribute.
            nofollow (bool): drop from a link entry itself.
        """
        return await _dry(
            "removexattr",
            (path,),
            lambda: self._vfs.removexattr(path, name, nofollow=nofollow),
        )

    async def mkdir(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.mkdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("mkdir", (path,), lambda: self._vfs.mkdir(path))

    async def rmdir(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.rmdir``.

        Args:
            path (str): the directory.
        """
        return await _dry("rmdir", (path,), lambda: self._vfs.rmdir(path))

    async def unlink(self, path: str) -> VfsExplanation:
        """Explain ``session.vfs.unlink``.

        Args:
            path (str): the path.
        """
        return await _dry("unlink", (path,), lambda: self._vfs.unlink(path))

    async def rename(self, src: str, dst: str) -> VfsExplanation:
        """Explain ``session.vfs.rename``.

        Args:
            src (str): the path moved.
            dst (str): where it would land.
        """
        return await _dry(
            "rename", (src, dst), lambda: self._vfs.rename(src, dst)
        )

    async def truncate(self, path: str, length: int) -> VfsExplanation:
        """Explain ``session.vfs.truncate``.

        Args:
            path (str): the path.
            length (int): the length it would be cut to.
        """
        return await _dry(
            "truncate", (path,), lambda: self._vfs.truncate(path, length)
        )


async def _dry(
    call: str, paths: tuple[str, ...], run: Callable[[], Awaitable[Any]]
) -> VfsExplanation:
    """Walk one VFS call through its door as a dry run and say what its
    gates answered.

    Args:
        call (str): the call's name.
        paths (tuple[str, ...]): its path arguments, as given.
        run (Callable[[], Awaitable[Any]]): the call on the session's
            facade.

    Raises:
        RuntimeError: the call returned, so it ran past its gate, which
            no door may let it do.
    """
    trace: list[VfsExplanation] = []
    token = set_explaining(trace)
    try:
        await run()
    except Explained:
        pass
    except OSError as exc:
        if trace:
            raise
        logger.debug("%s answered before its gate: %s", call, exc)
    else:
        raise RuntimeError(f"{call} ran past its gate in a dry run")
    finally:
        reset_explaining(token)
    if not trace:
        return VfsExplanation(call=call, paths=paths)
    shown = next((e for e in trace if e.error), trace[-1])
    return dataclasses.replace(
        shown,
        call=call,
        paths=paths,
        answers=tuple(a for e in trace for a in e.answers),
    )
