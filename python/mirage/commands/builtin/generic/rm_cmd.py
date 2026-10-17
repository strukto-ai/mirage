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

from mirage.commands.builtin.utils.paths import descendant_path
from mirage.commands.spec.usage import missing_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.view.types import MountView

logger = logging.getLogger(__name__)


def rm_without_operands(force: bool) -> tuple[ByteSource | None, IOResult]:
    """rm's answer to a line with no operand, in GNU's words: nothing at
    all under ``-f``, and a missing-operand usage error otherwise
    (coreutils 9.7).

    Args:
        force (bool): ``-f``, under which a missing operand is no error.

    Raises:
        UsageError: without ``-f``.
    """
    if force:
        return None, IOResult()
    raise missing_operand_error("rm", None)


async def remove_tree(
    root: PathSpec,
    *,
    readdir: Callable[[PathSpec], Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    unlink: Callable[[PathSpec], Awaitable[None]],
    rmdir: Callable[[PathSpec], Awaitable[None]],
    mounts: MountView | None,
    force: bool,
) -> tuple[list[tuple[PathSpec, bool]], list[tuple[PathSpec, OSError]]]:
    """Remove a directory tree entry by entry, as GNU ``rm -r`` does.

    For a tree whose one-call removal the dispatcher declined, so each
    removal is judged on its own. An entry that cannot be removed, or a
    directory that cannot be opened, is a failure, and the directories
    above it stay without a line of their own, since they are not empty
    (coreutils 9.7). The links a directory holds go with it; a hidden one
    is left to the directory's own removal, which takes what the session
    cannot see. A mount below is never entered, as GNU's
    ``--one-file-system`` does, and the directories holding one stay.
    Under ``-f`` an entry gone before its removal is no failure.

    Args:
        root (PathSpec): the directory operand.
        readdir (Callable): lists a directory's full child paths.
        stat (Callable): stats a path.
        unlink (Callable): removes a file or a link.
        rmdir (Callable): removes an empty directory.
        mounts (MountView | None): the mount boundaries the walk stops
            at.
        force (bool): ``-f``.

    Returns:
        tuple: the removed entries as ``(path, is_dir)``, children
        first, and each failure with its error.
    """
    roots = (
        set(mounts.descendants(root.virtual)) if mounts is not None else set()
    )
    removed: list[tuple[PathSpec, bool]] = []
    failures: list[tuple[PathSpec, OSError]] = []

    async def remove(path: PathSpec, is_dir: bool) -> bool:
        try:
            if not is_dir:
                await unlink(path)
                removed.append((path, False))
                return True
            names = await readdir(path)
        except FS_ERRORS as exc:
            if force and isinstance(exc, FileNotFoundError):
                return True
            failures.append((path, exc))
            return False
        base = path.virtual.rstrip("/")
        cleared = True
        for name in names:
            child = descendant_path(root, name.rstrip("/"))
            if child.virtual in roots:
                continue
            try:
                info = await stat(child)
            except FileNotFoundError as exc:
                logger.debug(
                    "gone before rm reached %s: %s", child.virtual, exc
                )
                continue
            except FS_ERRORS as exc:
                failures.append((child, exc))
                cleared = False
                continue
            gone = await remove(child, info.type == FileType.DIRECTORY)
            cleared = cleared and gone
        if not cleared or any(r.startswith(f"{base}/") for r in roots):
            return False
        try:
            await rmdir(path)
        except FS_ERRORS as exc:
            if force and isinstance(exc, FileNotFoundError):
                return True
            failures.append((path, exc))
            return False
        removed.append((path, True))
        return True

    await remove(root, True)
    return removed, failures
