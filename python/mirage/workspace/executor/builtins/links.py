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

import time
from collections.abc import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import FileType, PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

# Commands whose path operands name the link itself (lstat semantics):
# rm/mv mutate the link entry, ln/readlink inspect it, rmdir must not
# descend through it. Everything else follows links before dispatch,
# mirroring open(2).
NO_FOLLOW_COMMANDS = frozenset({"rm", "mv", "ln", "readlink", "rmdir"})


def _typed(arg: str | PathSpec) -> str:
    if isinstance(arg, PathSpec):
        return arg.raw_path or arg.virtual
    return arg


def _split_flags(
    args: list[str | PathSpec],
    known: str,
) -> tuple[set[str], list[str | PathSpec]]:
    flags: set[str] = set()
    operands: list[str | PathSpec] = []
    parsing = True
    for arg in args:
        s = arg.virtual if isinstance(arg, PathSpec) else str(arg)
        if parsing and s == "--":
            parsing = False
            continue
        if (parsing and s != "-" and len(s) >= 2 and s.startswith("-")
                and all(c in known for c in s[1:])):
            flags.update(s[1:])
            continue
        parsing = False
        operands.append(arg)
    return flags, operands


def link_flags(args: list[str | PathSpec], known: str) -> set[str]:
    flags, _ = _split_flags(args, known)
    return flags


def _abs(arg: str | PathSpec, cwd: str) -> str:
    if isinstance(arg, PathSpec):
        return arg.virtual
    return resolve_path(arg, cwd)


def handle_ln(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    flags, operands = _split_flags(args, "sfnv")
    if len(operands) < 2:
        err = b"ln: missing file operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="ln",
                                                         exit_code=1,
                                                         stderr=err)
    link_abs = _abs(operands[1], session.cwd)
    target_typed = _typed(operands[0])
    exists = namespace.is_link(link_abs) and "f" not in flags
    if namespace.is_mount_root(link_abs) or exists:
        err = (f"ln: failed to create symbolic link "
               f"'{_typed(operands[1])}': File exists\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="ln",
                                                         exit_code=1,
                                                         stderr=err)
    namespace.symlink(link_abs, target_typed, time.time())
    out = None
    if "v" in flags:
        out = (f"'{_typed(operands[1])}' -> '{target_typed}'\n").encode()
    return out, IOResult(), ExecutionNode(command="ln", exit_code=0)


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
            raise CycleError(item.raw_path or item.virtual) from None
        if virtual == item.virtual:
            out.append(item)
            continue
        out.append(
            PathSpec(virtual=virtual,
                     directory=virtual[:virtual.rfind("/") + 1] or "/",
                     resource_path="",
                     pattern=item.pattern,
                     resolved=item.resolved,
                     raw_path=item.raw_path or item.virtual))
    return out


def strip_link_operands(
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
            namespace.unlink(item.virtual)
            removed += 1
            continue
        kept.append(item)
    return kept, removed


async def prepare_mv(
    namespace: Namespace,
    dispatch: Callable,
    items: list[str | PathSpec],
) -> tuple[list[str | PathSpec], str | None, tuple[ByteSource | None, IOResult,
                                                   ExecutionNode] | None]:
    """Adjust a two-operand ``mv`` for symlink operands.

    A link source renames the link entry itself (into a destination
    directory when one exists, mirroring rename(2) preceded by mv's dst
    stat). A link destination whose target is a directory is followed
    (mv moves into it); any other link destination is replaced, so its
    entry must drop once the backend move succeeds.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        dispatch (Callable): op dispatcher used to stat the destination.
        items (list[str | PathSpec]): classified command parts.

    Returns:
        tuple: (possibly rewritten parts, link path to unlink after a
        successful backend move, early result when the mv completed as a
        pure namespace rename).
    """
    paths = [p for p in items if isinstance(p, PathSpec)]
    if len(paths) != 2:
        return items, None, None
    src, dst = paths

    if namespace.is_link(src.virtual):
        target_dst = dst.virtual
        stat = await _stat_or_none(dispatch, dst)
        if stat is not None and stat.type == FileType.DIRECTORY:
            target_dst = (dst.virtual.rstrip("/") + "/" +
                          src.virtual.rsplit("/", 1)[-1])
        namespace.unlink(target_dst)
        namespace.rename(src.virtual, target_dst)
        return items, None, (None, IOResult(),
                             ExecutionNode(command="mv", exit_code=0))

    if namespace.is_link(dst.virtual):
        followed = namespace.follow(dst.virtual)
        stat = await _stat_or_none(dispatch, PathSpec.from_str_path(followed))
        if stat is not None and stat.type == FileType.DIRECTORY:
            return follow_paths(namespace, items), None, None
        return items, dst.virtual, None

    return items, None, None


async def _stat_or_none(dispatch: Callable, path: PathSpec):
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


def handle_readlink(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    flags, operands = _split_flags(args, "fenm")
    if not operands:
        err = b"readlink: missing operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="readlink",
                                                         exit_code=1,
                                                         stderr=err)
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        target = namespace.readlink(_abs(op, session.cwd))
        if target is None:
            exit_code = 1
            continue
        lines.append(target)
    if not lines:
        return None, IOResult(exit_code=exit_code), ExecutionNode(
            command="readlink", exit_code=exit_code)
    if "n" in flags:
        text = "".join(lines)
    else:
        text = "".join(line + "\n" for line in lines)
    return text.encode(), IOResult(exit_code=exit_code), ExecutionNode(
        command="readlink", exit_code=exit_code)
