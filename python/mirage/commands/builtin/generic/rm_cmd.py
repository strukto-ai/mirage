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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import (
    Operation,
    mount_io,
    require_op,
)
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.paths import descendant_path
from mirage.commands.config import CommandOpts, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.hidden import path_visible
from mirage.view.types import NamespaceView


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
    raise UsageError(
        "rm: missing operand\nTry 'rm --help' for more information.", 1
    )


async def remove_tree(
    root: PathSpec,
    *,
    readdir: Callable[[PathSpec], Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    unlink: Callable[[PathSpec], Awaitable[None]],
    rmdir: Callable[[PathSpec], Awaitable[None]],
    ns: NamespaceView | None,
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
        ns (NamespaceView | None): the namespace's links, mounts and the
            session's visibility.
        force (bool): ``-f``.

    Returns:
        tuple: the removed entries as ``(path, is_dir)``, children
        first, and each failure with its error.
    """
    links = ns.links if ns is not None else None
    vis = ns.visibility if ns is not None else None
    roots = (
        set(ns.mounts.descendants(root.virtual))
        if ns is not None and ns.mounts is not None
        else set()
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
            if links is not None and links.stat_at(child.virtual) is not None:
                continue
            try:
                info = await stat(child)
            except FileNotFoundError:
                continue
            except FS_ERRORS as exc:
                failures.append((child, exc))
                cleared = False
                continue
            gone = await remove(child, info.type == FileType.DIRECTORY)
            cleared = cleared and gone
        for row in links.children(base) if links is not None else []:
            link = descendant_path(root, f"{base}/{row.name}")
            if not path_visible(vis, link.virtual):
                continue
            gone = await remove(link, False)
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


async def _file_rm(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """``rm`` over the mount's ``unlink``, for files only.

    Args:
        accessor (Accessor): Backend handle.
        paths (list[PathSpec]): The operands.
        texts (list[str]): Text arguments, unused.
        opts (CommandOpts): The invocation's options.
    """
    fl = FlagView(opts.flags, spec=SPECS["rm"])
    f = fl.as_bool("f")
    v = fl.as_bool("v")
    if not paths:
        return rm_without_operands(f)
    io = mount_io(opts)
    unlink = require_op(io, Operation.UNLINK)
    paths = await io.resolve_glob(accessor, paths, opts.index)
    verbose_parts: list[str] = []
    errors: list[str] = []
    for p in paths:
        try:
            await unlink(accessor, p)
        except FS_ERRORS as exc:
            if f and isinstance(exc, (FileNotFoundError, NotADirectoryError)):
                continue
            # GNU rm reports the operand and keeps removing the rest.
            errors.append(
                f"rm: cannot remove '{p.raw_path}': {fs_strerror(exc)}"
            )
            continue
        except ValueError:
            if f:
                continue
            errors.append(
                f"rm: cannot remove '{p.raw_path}': No such file or directory"
            )
            continue
        if v:
            verbose_parts.append(f"removed '{p.raw_path}'")
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)


def make_rm(*, vfs: str) -> Callable[..., Any]:
    """Build a file-only ``rm`` over the mount's ``unlink``.

    For backends with files and no directories of their own to remove.
    The unlink goes through the dispatcher, which judges each path and
    settles the removal.

    Args:
        vfs (str): VFS name the command registers under.
    """
    rm: Callable[..., Any] = command(
        "rm", vfs=vfs, spec=SPECS["rm"], write=True, path_guarded=True
    )(_file_rm)
    return rm
