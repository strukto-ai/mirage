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

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from mirage.commands.errors import UsageError, WalkLimitError
from mirage.errors.classify import classify
from mirage.errors.types import FsCondition, WalkDeclinedError
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.view.types import MountView

logger = logging.getLogger(__name__)

# The conditions under which a guard's path reaches no directory to walk.
_NO_DIRECTORY = (FsCondition.ENOENT, FsCondition.ENOTDIR, FsCondition.ELOOP)

ReadTree = Callable[..., Awaitable[dict[str, FileStat] | None]]
WalkCall = Callable[..., Awaitable[Any]]


async def before_full_walk(
    dispatch: DispatchFn | None, path: PathSpec, command: str
) -> None:
    """Let the mount that owns ``path`` refuse a command about to read
    every file under it.

    The mount is asked at the resolved path: the command already judged
    the spelling it was typed in, and reports a path that reaches no
    directory (missing, not one, a link loop) itself. The mount refuses
    with a ValueError, which becomes the command's own error,
    ``command: message`` and exit 1, on one mount or across several.

    Args:
        dispatch (DispatchFn | None): the command's dispatcher; None
            leaves no mount to ask.
        path (PathSpec): the directory about to be walked.
        command (str): the command that walks it.

    Raises:
        UsageError: the mount refused the walk.
    """
    if dispatch is None:
        return
    try:
        await dispatch(
            "before_full_walk", PathSpec.from_str_path(path.virtual)
        )
    except UsageError:
        raise
    except ValueError as exc:
        raise UsageError(f"{command}: {exc}", exit_code=1) from exc
    except OSError as exc:
        if classify(exc) not in _NO_DIRECTORY:
            raise
        logger.debug("walk guard at %s: %s", path.virtual, exc)


@dataclass(slots=True)
class WalkBudget:
    """The entries one walk of an operand may still list.

    A walk lists at most ``walk_limit`` entries of each mount it
    crosses: an entry is charged to the mount serving the directory that
    lists it, counted under the operand, or under the mount's root where
    that mount starts below the operand. Once a count runs out the walk
    lists nothing more there, and ``stopped`` holds what the command
    says about it, one line per folder.

    Args:
        operand (PathSpec): the walked operand.
        mounts (MountView | None): the mount table; None counts nothing.
        spent (dict[str, int]): entries charged per counted folder.
        stopped (list[str]): the stop lines, without the command's name,
            in the order the walk met them.
    """

    operand: PathSpec
    mounts: MountView | None
    spent: dict[str, int] = field(default_factory=dict)
    stopped: list[str] = field(default_factory=list)

    def _limit(self, directory: str) -> int:
        if self.mounts is None or self.mounts.walk_limit is None:
            return -1
        return self.mounts.walk_limit(directory)

    def _folder(self, directory: str) -> str:
        assert self.mounts is not None
        top = self.operand.virtual.rstrip("/")
        root = self.mounts.root_of(directory).rstrip("/")
        return root if root.startswith(top + "/") else top or "/"

    def _stop(self, folder: str, limit: int) -> None:
        top = self.operand.virtual.rstrip("/") or "/"
        line = str(
            WalkLimitError(
                self.operand
                if folder == top
                else PathSpec.from_str_path(folder),
                limit,
            )
        )
        if line not in self.stopped:
            self.stopped.append(line)

    def spend(self, directory: str) -> bool:
        """Charge one entry ``directory`` lists, or the one file a search
        reads when ``directory`` is that file.

        Args:
            directory (str): virtual path of the listed directory, or of
                the file read.

        Returns:
            bool: True if the walk may keep the entry, False once its
            folder's count is out, which records the stop.
        """
        limit = self._limit(directory)
        if limit < 0:
            return True
        folder = self._folder(directory)
        used = self.spent.get(folder, 0)
        if used < limit:
            self.spent[folder] = used + 1
            return True
        self._stop(folder, limit)
        return False

    def opens(self, directory: str) -> bool:
        """Whether the walk may still list ``directory``; a folder whose
        count is out records the stop and is not listed at all.

        Args:
            directory (str): virtual path of the directory.
        """
        limit = self._limit(directory)
        if limit < 0:
            return True
        folder = self._folder(directory)
        if self.spent.get(folder, 0) < limit:
            return True
        self._stop(folder, limit)
        return False

    async def listing(
        self,
        readdir: Callable[[PathSpec], Awaitable[list[str]]],
        directory: PathSpec,
    ) -> list[str]:
        """``readdir`` of ``directory``, cut to what the walk may still
        list.

        Args:
            readdir (Callable): the walk's readdir.
            directory (PathSpec): the directory to list.
        """
        if not self.opens(directory.virtual):
            return []
        return [
            name
            for name in await readdir(directory)
            if self.spend(directory.virtual)
        ]


def _listings(found: dict[str, FileStat]) -> dict[str, list[str]]:
    """Each directory's children in name order, keyed by its path below
    the walk's root (``""`` for the root itself).

    Args:
        found (dict[str, FileStat]): the ``read_tree`` answer.
    """
    children: dict[str, set[str]] = {"": set()}
    for key, st in found.items():
        parts = key.split("/")
        for depth in range(1, len(parts) + 1):
            rel = "/".join(parts[:depth])
            children.setdefault("/".join(parts[: depth - 1]), set()).add(rel)
        if st.type is FileType.DIRECTORY:
            children.setdefault(key, set())
    for rel in [r for r in children if r and r not in found]:
        found[rel] = FileStat(
            name=rel.rsplit("/", 1)[-1], type=FileType.DIRECTORY
        )
    return {rel: sorted(names) for rel, names in children.items()}


def _answerable(path: PathSpec) -> bool:
    """Whether an earlier answer may stand for ``path``. A spelling with
    dots or a trailing slash (``dotted``) or one the walk refused
    (``walk_error``) goes to the call, so the dispatcher checks it.

    Args:
        path (PathSpec): the path the walk asks about.
    """
    return path.dotted is None and path.walk_error is None


def tree_walk(
    read_tree: ReadTree | None,
    readdir: WalkCall,
    stat: WalkCall,
) -> tuple[WalkCall, WalkCall]:
    """A walk's ``readdir`` and ``stat``, answered from the mount's
    ``read_tree``.

    The first ``readdir`` of a directory no answer covers asks
    ``read_tree`` for everything under it, and every later ``readdir``
    and ``stat`` below it answers from that, so a walk costs one call. An
    answer of None, a mount without ``read_tree``, or a dispatcher that
    declines it (a path rule below the directory) leaves the walk to
    ``readdir`` and ``stat``, each judged on its own, as does a path the
    answer does not hold; under a hide the dispatcher answers without the
    hidden entries. A subtree read stops at a link (ENOTDIR), so a
    directory a walk reached through one is opened by ``readdir``, which
    follows it as opendir(3) does and meets whatever refuses the
    directory it leads to. Both take the path first and pass everything
    else through.

    Args:
        read_tree (ReadTree | None): the mount's ``read_tree``, bound to
            its accessor and index, called as ``read_tree(path)``.
        readdir (WalkCall): the walk's own readdir.
        stat (WalkCall): the walk's own stat.
    """
    if read_tree is None:
        return readdir, stat
    roots: dict[str, tuple[dict[str, FileStat], dict[str, list[str]]]] = {}
    asked: set[str] = set()

    def covering(virtual: str) -> tuple[str, str] | None:
        for root in roots:
            if virtual == root:
                return root, ""
            base = root.rstrip("/") + "/"
            if virtual.startswith(base):
                return root, virtual[len(base) :]
        return None

    async def tree_readdir(path: PathSpec, *args: Any, **kwargs: Any) -> Any:
        virtual = path.virtual.rstrip("/") or "/"
        hit = covering(virtual) if _answerable(path) else None
        if hit is None and virtual not in asked and not path.pattern:
            asked.add(virtual)
            try:
                found = await read_tree(path)
            except (WalkDeclinedError, NotADirectoryError):
                found = None
            if found is not None:
                found = dict(found)
                roots[virtual] = (found, _listings(found))
                hit = virtual, ""
        if hit is not None:
            root, rel = hit
            listing = roots[root][1].get(rel)
            if listing is not None:
                base = root.rstrip("/") + "/"
                return [base + name for name in listing]
        return await readdir(path, *args, **kwargs)

    async def tree_stat(path: PathSpec, *args: Any, **kwargs: Any) -> Any:
        virtual = path.virtual.rstrip("/") or "/"
        hit = covering(virtual) if _answerable(path) else None
        if hit is not None and hit[1]:
            found = roots[hit[0]][0].get(hit[1])
            if found is not None:
                return found
        return await stat(path, *args, **kwargs)

    return tree_readdir, tree_stat
