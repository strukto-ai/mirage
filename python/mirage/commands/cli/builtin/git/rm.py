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

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass

from dulwich.index import IndexEntry

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.changes import (
    DELETED,
    MODIFIED,
    TYPE_CHANGED,
    head_entries,
    work_changes,
)
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    NoPathspecRemoveError,
    NotRecursiveError,
    NoWorkspaceError,
    PathspecError,
    RemovalRefusedError,
    RemovePathError,
)
from mirage.commands.cli.builtin.git.index_file import read_index, write_index
from mirage.commands.cli.builtin.git.io import (
    blocking_ancestor,
    is_link,
    remove_empty_parents,
    remove_file,
    stat_of,
)
from mirage.commands.cli.builtin.git.pathspec import (
    decoded,
    matched,
    repo_relative,
    visible_entries,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation, WorkTree
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    start_point,
)
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_NO, scan
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.workspace.files import Files

Tree = dict[bytes, tuple[int, bytes]]


@dataclass(frozen=True, slots=True)
class RmFlags:
    """The parsed shape of a ``git rm`` invocation.

    Args:
        recursive (bool): ``-r``, allow a directory operand.
        cached (bool): ``--cached``, unstage only and keep the file.
        force (bool): ``-f``, remove even over uncommitted changes.
        quiet (bool): ``-q``, print no ``rm`` line per path.
        ignore_unmatch (bool): ``--ignore-unmatch``, an operand naming
            nothing is not an error.
    """

    recursive: bool
    cached: bool
    force: bool
    quiet: bool
    ignore_unmatch: bool


def parse_flags(fl: FlagView) -> RmFlags:
    """Read the raw rm flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    return RmFlags(
        recursive=fl.as_bool("r"),
        cached=fl.as_bool("cached"),
        force=fl.as_bool("force"),
        quiet=fl.as_bool("quiet"),
        ignore_unmatch=fl.as_bool("ignore_unmatch"),
    )


def select(
    location: RepoLocation,
    start: str,
    operands: Sequence[str],
    tracked: set[str],
    flags: RmFlags,
) -> list[str]:
    """Which tracked paths the operands remove, in index order.

    Every operand is checked before anything is removed, which is git's
    order too: a line with one bad operand removes nothing. A directory
    is refused without ``-r`` rather than expanded, and an operand that
    names nothing tracked is a fatal unless ``--ignore-unmatch`` says
    otherwise. An untracked file is "nothing tracked": git has nothing
    to remove it from.

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operands (Sequence[str]): the pathspecs as typed.
        tracked (set[str]): repository-relative paths the index holds.
        flags (RmFlags): the parsed flags.
    """
    selected: set[str] = set()
    for operand in operands:
        target = repo_relative(location, start, operand)
        if target in tracked:
            selected.add(target)
            continue
        hits = matched(tracked, target)
        if not hits:
            if flags.ignore_unmatch:
                continue
            raise PathspecError(operand)
        if not flags.recursive:
            raise NotRecursiveError(operand)
        selected |= hits
    return sorted(selected)


async def shadowed(
    vfs: Files,
    worktree: PathSpec,
    paths: list[str],
    missing: dict[str, str],
) -> set[str]:
    """Which absent paths a link above them is only hiding.

    git lstats a tracked path to decide whether it still has local work
    to lose, and that lstat resolves every component above the file, so
    a symlink standing where a directory was does not hide the file: it
    points the check at whatever lies at the other end, which is some
    other file entirely and therefore a local change. The walk answers
    the opposite way on purpose, because git's own diff refuses to
    follow a leading link and reports the path deleted, which is why
    ``git status`` says ``D`` here and ``git rm`` still refuses.
    Nothing is compared: two files agreeing byte for byte are still two
    files, and git refuses that case too. Pinned against git 2.50.1.

    Args:
        vfs (Files): the session's files.
        worktree (PathSpec): absolute virtual path of the working tree root.
        paths (list[str]): the selected paths that hold an index entry.
        missing (dict[str, str]): what the walk said about each path.
    """
    found: set[str] = set()
    for path in paths:
        if missing.get(path) != DELETED:
            continue
        if await blocking_ancestor(vfs, worktree, path) is None:
            continue
        if await vfs.exists(worktree.join(path)):
            found.add(path)
    return found


async def refuse_lost_work(
    vfs: Files,
    location: RepoLocation,
    tree: Tree,
    entries: dict[bytes, IndexEntry],
    found: WorkTree,
    paths: list[str],
    cached: bool,
) -> None:
    """Refuse a removal that would throw away uncommitted work.

    git's own three-way test per path: whether the index differs from
    HEAD, and whether the working tree differs from the index. A path
    that differs both ways is refused outright; one that differs one
    way is refused unless ``--cached`` keeps the file. A file already
    gone from the working tree has no local change to lose, which is
    what makes ``git rm <deleted>`` the way to stage a deletion. Pinned
    against git 2.50.1.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        tree (Tree): HEAD's tree, empty before the first commit.
        entries (dict[bytes, IndexEntry]): the index.
        found (WorkTree): what the walk of the working tree found.
        paths (list[str]): the selected paths that hold an index entry.
        cached (bool): whether ``--cached`` was given.
    """
    chosen = {path.encode(): entries[path.encode()] for path in paths}
    unstaged = await work_changes(vfs, location.worktree, chosen, found)
    hidden = await shadowed(vfs, location.worktree, paths, unstaged)
    both: list[str] = []
    staged: list[str] = []
    local: list[str] = []
    for path in paths:
        entry = chosen[path.encode()]
        recorded = tree.get(path.encode())
        staged_changes = (
            recorded is None
            or recorded[1] != entry.sha
            or recorded[0] != entry.mode
        )
        local_changes = (
            unstaged.get(path) in (MODIFIED, TYPE_CHANGED) or path in hidden
        )
        if local_changes and staged_changes:
            both.append(path)
        elif not cached:
            if staged_changes:
                staged.append(path)
            if local_changes:
                local.append(path)
    if both or staged or local:
        raise RemovalRefusedError(both, staged, local)


async def clear_worktree(
    vfs: Files,
    location: RepoLocation,
    selected: list[str],
    lines: str,
) -> None:
    """Delete every selected path from the working tree.

    A directory standing where a tracked file was is the one deletion a
    mount cannot make: ``unlink`` is not the call that empties a tree,
    and git reports the strerror rather than removing what it never
    tracked. It reports it in index order and only while nothing has
    been deleted yet; once one path is gone the rest of the loop
    tolerates a failure and the line still succeeds. That is git's own
    rule rather than a reading of it, and it is observable both ways:
    ``git rm slot z.txt`` is fatal with the index untouched, while
    ``git rm a.txt slot`` exits 0 with both entries unstaged and the
    directory still on disk. Pinned against git 2.50.1.

    A tracked symlink to a directory is not this case and must not be
    read as one: it is removed as the link it is, which is why the
    lstat is asked before the type.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        selected (list[str]): the paths to delete, in index order.
        lines (str): the ``rm`` lines already printed, for a refusal to
            carry on stdout the way git prints them anyway.
    """
    removed = False
    for path in selected:
        absolute = location.worktree.join(path)
        if not await is_link(vfs, absolute):
            info = await stat_of(vfs, absolute)
            if info is not None and info.type is FileType.DIRECTORY:
                if not removed:
                    raise RemovePathError(path, lines)
                continue
        await remove_file(vfs, absolute)
        await remove_empty_parents(vfs, absolute, location.worktree)
        removed = True


async def rm(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Remove paths from the index, and from the working tree too.

    ``--cached`` leaves the file where it is and only stops tracking it.
    Without ``-f`` a path carrying uncommitted work is refused rather
    than deleted, which is the one check that makes the verb safe to
    hand an agent: there is no reflog here to recover a file from.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = ctx.vfs
    fl = FlagView(ctx.flags)
    try:
        if vfs is None:
            raise NoWorkspaceError()
        check_switches(ctx, texts)
        flags = parse_flags(fl)
        if not texts:
            raise NoPathspecRemoveError()
        repo, location = await opened(ctx, fl, work_tree=not flags.cached)
        state = await read_index(vfs, location.gitdir)
        tracked = decoded(
            set(visible_entries(location, state.entries))
            | set(visible_entries(location, state.conflicts))
        )
        selected = select(
            location, start_point(fl).virtual, texts, tracked, flags
        )
        if not flags.force:
            checkable = [
                path for path in selected if path.encode() in state.entries
            ]
            found = await scan(
                vfs,
                location,
                tracked,
                UNTRACKED_NO,
            )
            tree = await asyncio.to_thread(head_entries, repo) or {}
            await refuse_lost_work(
                vfs,
                location,
                tree,
                state.entries,
                found,
                checkable,
                flags.cached,
            )
        lines = (
            ""
            if flags.quiet
            else "".join(f"rm '{path}'\n" for path in selected)
        )
        if not flags.cached:
            await clear_worktree(
                vfs,
                location,
                selected,
                lines,
            )
        # Last, because the deletions above can fail: git writes the
        # index only once the working tree is done with, so a refused
        # deletion leaves the entry staged exactly as it stood rather
        # than staging a removal that never happened.
        for path in selected:
            state.entries.pop(path.encode(), None)
            state.conflicts.pop(path.encode(), None)
        await write_index(vfs, location.gitdir, state)
    except GitError as exc:
        return fatal(exc)
    if flags.quiet:
        return None, IOResult()
    return yield_bytes(lines.encode()), IOResult()
