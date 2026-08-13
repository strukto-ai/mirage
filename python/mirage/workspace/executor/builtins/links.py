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
import posixpath
import time

from mirage.io import IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec, word_text
from mirage.utils.errors import MISS_ERRORS
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.shared import (Result, abs_path, fail,
                                                       ok, split_flags)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


def link_flags(args: list[str | PathSpec], known: str) -> set[str]:
    flags, _ = split_flags(args, known)
    return flags


async def handle_ln(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """ln -s TARGET LINK: create a namespace symbolic link.

    Flags: -f overwrite an existing link, -v report the link, -r store
    the target relative to the link's directory (GNU --relative). -n
    (--no-dereference) and -T (--no-target-directory) are accepted no-ops:
    a namespace link name is never dereferenced nor treated as a directory
    to descend into, so both are already the effective behavior.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        session (Session): session whose cwd resolves relative operands.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, operands = split_flags(args, "sfnvrT")
    if len(operands) < 2:
        return fail("ln", "ln: missing file operand\n")
    # GNU: with more than two operands the last must be a directory;
    # namespace links never name directories, so this is always an error
    # (an expanded multi-match glob source lands here).
    if len(operands) > 2:
        return fail(
            "ln", f"ln: target '{word_text(operands[-1])}': "
            f"Not a directory\n")
    link_abs = abs_path(operands[1], session.cwd)
    target_typed = word_text(operands[0])
    if "r" in flags:
        # --relative: rewrite the target relative to the link's own
        # directory so the link stays valid addressed from anywhere. GNU
        # canonicalizes existing symlink components of both ends first, so
        # an aliased directory resolves to its real path (the link survives
        # the alias being moved/removed); fall back to lexical on a loop.
        link_dir = posixpath.dirname(link_abs) or "/"
        target_abs = abs_path(operands[0], session.cwd)
        try:
            target_abs = namespace.follow(target_abs)
            link_dir = namespace.follow(link_dir)
        except CycleError:
            pass
        target_typed = posixpath.relpath(target_abs, link_dir)
    exists = namespace.is_link(link_abs) and "f" not in flags
    if namespace.is_mount_root(link_abs) or exists:
        return fail(
            "ln", f"ln: failed to create symbolic link "
            f"'{word_text(operands[1])}': File exists\n")
    await namespace.symlink(link_abs, target_typed, time.time())
    out = None
    if "v" in flags:
        out = (f"'{word_text(operands[1])}' -> '{target_typed}'\n").encode()
    return ok("ln", out)


async def resolve_path_stat(dispatch: DispatchFn,
                            path: PathSpec) -> FileStat | None:
    """What a path is, asked on both channels a backend can answer on.

    A point lookup alone cannot decide. On a prefix store a directory is
    not an object, it is the set of keys under it, so ``stat`` misses
    what ``readdir`` would list. Absence therefore takes *both* channels
    coming back empty, which is the only evidence that nothing is there.

    The listing has to be non-empty to count: those stores answer a
    missing path with ``[]`` rather than raising, and cannot hold an
    empty directory anyway (one with no keys under it does not exist).
    Measured across every integ target: an implicit directory answers
    here, a missing path does not.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to resolve.
    """
    try:
        stat, _ = await dispatch("stat", path)
    except MISS_ERRORS:
        stat = None
    if stat is not None:
        return stat
    try:
        entries, _ = await dispatch("readdir", path)
    except MISS_ERRORS:
        return None
    if not entries:
        return None
    return FileStat(name=posixpath.basename(path.virtual.rstrip("/")),
                    type=FileType.DIRECTORY)


async def path_stat(dispatch: DispatchFn, virtual: str) -> FileStat | None:
    """Stat one virtual path through the workspace, None when absent.

    Resolves through the op dispatcher rather than one backend, so a path
    under another mount answers correctly. This is what a traversal
    command asks about its own start point: a directory can be walked, a
    file is reported as itself, and None is GNU's missing-operand error.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path.
    """
    spec = PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1] or "/",
                    resource_path="")
    return await resolve_path_stat(dispatch, spec)


async def path_readdir(dispatch: DispatchFn, virtual: str) -> list[str]:
    """List one virtual path through the workspace, as virtual paths.

    Resolves through the op dispatcher rather than one backend, so a
    directory served by another mount answers. This is what a walker
    reads once it crosses a mount boundary: the subtree under a nested
    mount lives in a resource the walker's own accessor cannot open.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the directory.
    """
    spec = PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1] or "/",
                    resource_path="")
    entries, _ = await dispatch("readdir", spec)
    return list(entries)


async def path_exists(dispatch: DispatchFn, virtual: str) -> bool:
    """Whether a resolved virtual path names something that exists.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path.
    """
    try:
        return await path_stat(dispatch, virtual) is not None
    except (OSError, ValueError):
        return False


async def link_target_stat(namespace: Namespace, dispatch: DispatchFn,
                           virtual: str) -> FileStat | None:
    """The stat of what a link points at, or None when it dangles.

    Under ``-L`` the reported entity is the target, so its type drives
    ``-type`` and its size and mtime drive ``-size`` and ``-mtime``. The
    stat goes through dispatch rather than one backend because a link
    may point into another mount.

    Only the two ways a link can legitimately have no target are mapped
    to None: a loop (ELOOP) and a missing target, the latter by
    ``_stat_or_none``. Every other backend failure propagates, because a
    permission or connection error is not a dangling link and reporting
    it as one would print the link as ``-type l`` and exit 0.

    Args:
        namespace (Namespace): addressing authority holding the links.
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the link.
    """
    try:
        target = namespace.follow(virtual)
    except CycleError:
        return None
    spec = PathSpec(virtual=target,
                    directory=target[:target.rfind("/") + 1] or "/",
                    resource_path="")
    return await _stat_or_none(dispatch, spec)


async def handle_readlink(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """Print a symlink's target, GNU readlink semantics.

    The three canonicalizing flags differ only in how much of the
    resolved path has to exist: ``-m`` requires nothing, ``-f`` requires
    every component but the last, and ``-e`` requires all of it. A path
    that falls short prints nothing and exits 1.

    Args:
        namespace (Namespace): addressing authority holding the links.
        dispatch (DispatchFn): op dispatcher, used for the existence check.
        session (Session): current session, for the working directory.
        args (list[str | PathSpec]): the command's words after the name.
    """
    flags, operands = split_flags(args, "fenm")
    if not operands:
        return fail("readlink", "readlink: missing operand\n")
    canonical = any(f in flags for f in "fem")
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        abs_op = abs_path(op, session.cwd)
        if canonical:
            # -f/-e/-m canonicalize: resolve every symlink (including a
            # trailing one) and normalize the path, GNU realpath-style.
            try:
                resolved = posixpath.normpath(namespace.follow(abs_op))
            except CycleError:
                exit_code = 1
                continue
            probe = (resolved if "e" in flags else
                     posixpath.dirname(resolved) if "f" in flags else None)
            if probe is not None and not await path_exists(dispatch, probe):
                exit_code = 1
                continue
            lines.append(resolved)
            continue
        target = namespace.readlink(abs_op)
        if target is None:
            exit_code = 1
            continue
        lines.append(target)
    if "n" in flags:
        text = "".join(lines)
    else:
        text = "".join(line + "\n" for line in lines)
    return (text.encode() if text else None, IOResult(exit_code=exit_code),
            ExecutionNode(command="readlink", exit_code=exit_code))


def follow_paths(
    namespace: Namespace,
    items: list[str | PathSpec],
) -> list[str | PathSpec]:
    """Rewrite path operands through the symlink table (open(2) semantics).

    Non-path items and paths that resolve to themselves pass through
    untouched. A rewritten spec keeps the user-typed form in ``raw_path``
    so error messages still name the operand as typed; the mount re-stamps
    ``resource_path`` at dispatch.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        items (list[str | PathSpec]): classified command parts.

    Raises:
        CycleError: when a path loops past the hop limit (ELOOP).
    """
    out: list[str | PathSpec] = []
    for item in items:
        if not isinstance(item, PathSpec):
            out.append(item)
            continue
        try:
            virtual = namespace.follow(item.virtual)
        except CycleError:
            raise CycleError(item.raw_path) from None
        if virtual == item.virtual:
            out.append(item)
            continue
        out.append(
            dataclasses.replace(item,
                                virtual=virtual,
                                directory=virtual[:virtual.rfind("/") + 1]
                                or "/",
                                resource_path=""))
    return out


async def strip_link_operands(
    namespace: Namespace,
    items: list[str | PathSpec],
) -> tuple[list[str | PathSpec], int]:
    """Unlink and drop ``rm`` operands that are symlinks.

    GNU ``rm`` removes the link itself and never follows it; a dangling
    link removes fine. Remaining operands stay for backend dispatch.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        items (list[str | PathSpec]): classified command parts.

    Returns:
        tuple[list[str | PathSpec], int]: surviving parts and the number
        of link entries removed.
    """
    removed = 0
    kept: list[str | PathSpec] = []
    for item in items:
        if isinstance(item, PathSpec) and namespace.is_link(item.virtual):
            await namespace.unlink(item.virtual)
            removed += 1
            continue
        kept.append(item)
    return kept, removed


async def _stat_or_none(dispatch: DispatchFn,
                        path: PathSpec) -> FileStat | None:
    """Stat a path via dispatch, mapping a missing file to ``None``.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to stat.
    """
    # A missing destination is an expected mv case (plain rename), not an
    # error to surface.
    try:
        stat, _ = await dispatch("stat", path)
    except FileNotFoundError:
        return None
    return stat


async def prepare_mv(
    namespace: Namespace,
    dispatch: DispatchFn,
    items: list[str | PathSpec],
) -> tuple[list[str | PathSpec], str | None, tuple[str, str] | None, Result
           | None]:
    """Adjust a two-operand ``mv`` for node-meta operands.

    A link source renames the link entry itself. A destination that is
    (a link to) a directory receives the move inside it (rename(2)
    preceded by mv's dst stat); any other destination is replaced, so its
    node entry, link or overlay attrs alike, drops once the backend move
    succeeds. A plain source that carries overlay attributes has its meta
    travel with the file once the backend move succeeds.

    Args:
        namespace (Namespace): addressing authority holding the node table.
        dispatch (DispatchFn): op dispatcher used to stat the destination.
        items (list[str | PathSpec]): classified command parts.

    Returns:
        tuple: (possibly rewritten parts, node entry to drop after a
        successful backend move (the replaced destination), (src, dst)
        meta rename to apply after a successful backend move, early
        result when the mv completed as a pure namespace rename).
    """
    paths = [p for p in items if isinstance(p, PathSpec)]
    if len(paths) != 2:
        return items, None, None, None
    src, dst = paths

    # Where the move lands: inside a directory destination (followed, so
    # node-meta keys line up with the followed paths stat merges on), else
    # the destination itself, replaced like rename(2).
    followed = namespace.follow(dst.virtual)
    stat = await _stat_or_none(dispatch, PathSpec.from_str_path(followed))
    into_dir = stat is not None and stat.type == FileType.DIRECTORY
    if into_dir:
        target_dst = (followed.rstrip("/") + "/" +
                      posixpath.basename(src.virtual))
    else:
        target_dst = dst.virtual

    if namespace.is_link(src.virtual):
        await namespace.unlink(target_dst)
        await namespace.rename(src.virtual, target_dst)
        return items, None, None, ok("mv")

    post_rename: tuple[str, str] | None = None
    if namespace.meta_for(src.virtual) is not None:
        post_rename = (src.virtual, target_dst)

    rewritten = items
    if into_dir and namespace.is_link(dst.virtual):
        rewritten = follow_paths(namespace, items)
    return rewritten, target_dst, post_rename, None


__all__ = [
    "follow_paths",
    "handle_ln",
    "handle_readlink",
    "link_target_stat",
    "path_exists",
    "path_readdir",
    "link_flags",
    "prepare_mv",
    "resolve_path_stat",
    "strip_link_operands",
]
