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
from collections.abc import Callable

from mirage.io import IOResult
from mirage.types import FileStat, FileType, PathSpec, word_text
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
    flags, operands = split_flags(args, "sfnv")
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


def handle_readlink(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    flags, operands = split_flags(args, "fenm")
    if not operands:
        return fail("readlink", "readlink: missing operand\n")
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        target = namespace.readlink(abs_path(op, session.cwd))
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


async def _stat_or_none(dispatch: Callable, path: PathSpec) -> FileStat | None:
    """Stat a path via dispatch, mapping a missing file to ``None``.

    Args:
        dispatch (Callable): op dispatcher.
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
    dispatch: Callable,
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
        dispatch (Callable): op dispatcher used to stat the destination.
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
    "link_flags",
    "prepare_mv",
    "strip_link_operands",
]
