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

import posixpath
from dataclasses import dataclass

from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    GitError, MoveOverlapError, MoveRefusedError, MoveUsageError,
    NotADirectoryDestinationError, NoWorkspaceError, RenameFailedError,
    UnknownSwitchError)
from mirage.commands.cli.builtin.git.index import read_index, write_index
from mirage.commands.cli.builtin.git.io import remove_file, rename_path
from mirage.commands.cli.builtin.git.pathspec import repo_relative, under
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import IndexState, RepoLocation
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal, links_of, mounts_of, start_point, switches)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType
from mirage.utils.errors import MISS_ERRORS

# git's own wording for each way a source can be refused, in the shape
# ``fatal: <reason>, source=<src>, destination=<dst>``.
BAD_SOURCE = "bad source"
INTO_ITSELF = "can not move directory into itself"
DESTINATION_EXISTS = "destination exists"
DESTINATION_ALREADY_EXISTS = "destination already exists"
SOURCE_DIRECTORY_EMPTY = "source directory is empty"
NOT_UNDER_VERSION_CONTROL = "not under version control"
MULTIPLE_SOURCES = "multiple sources for the same target"
CONFLICTED = "conflicted"
# Not one of git's, because git has no concept to word: a mount is
# mirage's own boundary, so the refusal borrows the strerror the kernel
# gives for a rename it will not perform.
BUSY = "Device or resource busy"


@dataclass(frozen=True, slots=True)
class MvFlags:
    """The parsed shape of a ``git mv`` invocation.

    Args:
        force (bool): ``-f``, overwrite an existing destination file.
        skip (bool): ``-k``, skip a source that cannot move rather than
            refusing the line.
        dry_run (bool): ``-n``, report what would move and move nothing.
        verbose (bool): ``-v``, print one line per move; implied by
            ``-n``.
    """
    force: bool
    skip: bool
    dry_run: bool
    verbose: bool


def parse_flags(fl: FlagView) -> MvFlags:
    """Read the raw mv flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    dry_run = fl.as_bool("dry_run")
    return MvFlags(force=fl.as_bool("force"),
                   skip=fl.as_bool("k"),
                   dry_run=dry_run,
                   verbose=fl.as_bool("verbose") or dry_run)


@dataclass(frozen=True, slots=True)
class Move:
    """One source and where it goes.

    Args:
        source (str): repository-relative path being moved.
        destination (str): repository-relative path it moves to, already
            joined with the source's basename when the destination was a
            directory.
        paths (tuple[str, ...]): the tracked paths that move with it: the
            source itself for a file, everything under it for a
            directory.
        directory (bool): whether the source is a directory.
    """
    source: str
    destination: str
    paths: tuple[str, ...]
    directory: bool


async def lstat(stat_path: StatPath, links: LinkView | None,
                path: str) -> FileStat | None:
    """What sits at a path, without following a link.

    Args:
        stat_path (StatPath): dispatcher-backed stat, both channels.
        links (LinkView | None): the name plane's link facts.
        path (str): absolute virtual path.
    """
    if links is not None:
        link = links.stat_at(path)
        if link is not None:
            return link
    return await stat_path(path)


def moved_path(move: Move, path: str) -> str:
    """Where one tracked path lands after a move.

    Args:
        move (Move): the move.
        path (str): one of ``move.paths``.
    """
    if not move.directory:
        return move.destination
    return f"{move.destination}{path[len(move.source):]}"


def conflicting(move: Move, conflicted: set[str]) -> tuple[str, str] | None:
    """The first path in a move that the index left unmerged.

    Named the way the collision is named, by the path itself rather than
    by the operand that carried it, which is what git reports for a
    directory holding one.

    Args:
        move (Move): the move being planned.
        conflicted (set[str]): repository-relative paths with stages.

    Returns:
        tuple: the source path and the landing it wanted, or None.
    """
    for path in move.paths:
        if path in conflicted:
            return path, moved_path(move, path)
    return None


def clashing(move: Move, claimed: set[str]) -> tuple[str, str] | None:
    """The first path in a move that lands where an earlier one already does.

    Landings are compared one tracked path at a time rather than one
    operand at a time, because a directory operand moves every path
    under it and two directories sharing a child name collide there and
    nowhere else. git reports that collision by the colliding path too,
    not by the operand that carried it.

    Args:
        move (Move): the move being planned.
        claimed (set[str]): every landing the earlier moves take.

    Returns:
        tuple: the source path and the landing it wanted, or None.
    """
    for path in move.paths:
        landing = moved_path(move, path)
        if landing in claimed:
            return path, landing
    return None


def spanning(mounts: MountView | None, path: str, landing: str) -> bool:
    """Whether renaming a path would leave a mount behind.

    A mount nested in the repository is served by another VFS, and
    the rename op reaches only the backend holding the parent path: that
    backend cannot see the child's keys, so it moves everything except
    them and the index is then re-keyed onto files that never moved. The
    mount root itself is the same problem one level up, since the table
    still points at the old prefix. Neither is something the verb can
    repair afterwards, so both are refused before anything moves.

    The destination is the same fault read from the other end, and it
    catches an ordinary file the first two questions pass: the op is
    bound to the backend serving the source, so a landing another mount
    serves is written into the source's backend at a path it does not
    own. The file is then hidden behind the other mount while the index
    names the new path, which is the same broken pair one level down.

    Args:
        mounts (MountView | None): the name plane's mount boundaries,
            None outside a workspace.
        path (str): absolute virtual path of the source.
        landing (str): absolute virtual path the source moves to.
    """
    if mounts is None:
        return False
    if mounts.is_root(path) or bool(mounts.descendants(path)):
        return True
    return mounts.root_of(path) != mounts.root_of(landing)


async def check(stat_path: StatPath, links: LinkView | None,
                location: RepoLocation, source: str, destination: str,
                tracked: set[str], conflicted: set[str],
                force: bool) -> tuple[str | None, tuple[str, ...], bool]:
    """Whether one source can move, in git's own order of refusals.

    The index is read before the destination is looked at, which is
    git's order and observable: a conflicted source is refused as
    conflicted even when the destination is occupied, and a directory
    holding an unmerged path is refused for that rather than for a
    destination that already exists.

    Args:
        stat_path (StatPath): dispatcher-backed stat, both channels.
        links (LinkView | None): the name plane's link facts.
        location (RepoLocation): the discovered repository.
        source (str): repository-relative source.
        destination (str): repository-relative destination.
        tracked (set[str]): repository-relative paths the index holds,
            unmerged ones included.
        conflicted (set[str]): of those, the ones left unmerged.
        force (bool): whether ``-f`` was given.

    Returns:
        tuple: the refusal wording or None, the tracked paths that move,
        and whether the source is a directory.
    """
    info = await lstat(stat_path, links,
                       posixpath.join(location.worktree, source))
    if info is None:
        return BAD_SOURCE, (), False
    if destination == source or destination.startswith(f"{source}/"):
        return INTO_ITSELF, (), False
    landing = posixpath.join(location.worktree, destination)
    if info.type is FileType.DIRECTORY:
        inside = tuple(sorted(path for path in tracked if under(path, source)))
        if any(path in conflicted for path in inside):
            return CONFLICTED, inside, True
        if await lstat(stat_path, links, landing) is not None:
            return DESTINATION_ALREADY_EXISTS, (), True
        if not inside:
            return SOURCE_DIRECTORY_EMPTY, (), True
        return None, inside, True
    if source not in tracked:
        return NOT_UNDER_VERSION_CONTROL, (), False
    if source in conflicted:
        return CONFLICTED, (source, ), False
    target = await lstat(stat_path, links, landing)
    if target is not None and (not force or target.type is FileType.DIRECTORY):
        return DESTINATION_EXISTS, (), False
    return None, (source, ), False


def overlapping(moves: list[Move]) -> tuple[str, str] | None:
    """The first source that sits inside another source in the same line.

    git reads this off the whole line once every source has passed its
    own checks, which is why a source with a fault of its own is still
    refused for that fault first, and why ``-k`` skipping a source
    takes it out of this comparison too. The pair reported is the first
    directory source in operand order and the first source under it,
    named child first whatever order the line put them in.

    Args:
        moves (list[Move]): the moves planned so far, in operand order.

    Returns:
        tuple: the source inside the other and the directory holding
        it, or None when no source sits inside another.
    """
    for move in moves:
        if not move.directory:
            continue
        for other in moves:
            if under(other.source, move.source):
                return other.source, move.source
    return None


async def plan(stat_path: StatPath, links: LinkView | None,
               mounts: MountView | None, location: RepoLocation, start: str,
               operands: tuple[str, ...], tracked: set[str],
               conflicted: set[str], flags: MvFlags) -> list[Move]:
    """Decide every move before making any, which is git's order too.

    The last operand is the destination. With several sources it has to
    be a directory that exists; with one, an existing directory takes
    the source under its own name and anything else is the new name.

    Args:
        stat_path (StatPath): dispatcher-backed stat, both channels.
        links (LinkView | None): the name plane's link facts.
        mounts (MountView | None): the name plane's mount boundaries.
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operands (tuple[str, ...]): the operands as typed.
        tracked (set[str]): repository-relative paths the index holds,
            unmerged ones included.
        conflicted (set[str]): of those, the ones left unmerged.
        flags (MvFlags): the parsed flags.
    """
    destination = repo_relative(location, start, operands[-1])
    target = await lstat(stat_path, links,
                         posixpath.join(location.worktree, destination))
    into = destination == "" or (target is not None
                                 and target.type is FileType.DIRECTORY)
    if len(operands) > 2 and not into:
        raise NotADirectoryDestinationError(destination)
    moves: list[Move] = []
    claimed: set[str] = set()
    for operand in operands[:-1]:
        source = repo_relative(location, start, operand)
        landing = (posixpath.join(destination, posixpath.basename(source))
                   if into else destination)
        reason, paths, directory = await check(stat_path, links, location,
                                               source, landing, tracked,
                                               conflicted, flags.force)
        move = Move(source, landing, paths, directory)
        named = (source, landing)
        if reason == CONFLICTED:
            # git names the unmerged path, which for a directory is one
            # of the paths inside rather than the operand.
            found = conflicting(move, conflicted)
            if found is not None:
                named = found
        if reason is None:
            # Last of the per-source refusals, which is git's order:
            # a source with a fault of its own is refused for that
            # fault even when it also collides with an earlier one.
            clash = clashing(move, claimed)
            if clash is not None:
                reason, named = MULTIPLE_SOURCES, clash
        if reason is None and spanning(
                mounts, posixpath.join(location.worktree, source),
                posixpath.join(location.worktree, landing)):
            # Last, after every check git itself makes, so a source git
            # would refuse anyway is refused in git's own words. ``-k``
            # skips it like any other rename this source cannot survive.
            if flags.skip:
                continue
            raise RenameFailedError(source, BUSY)
        if reason is not None:
            if flags.skip:
                continue
            raise MoveRefusedError(reason, named[0], named[1])
        claimed.update(moved_path(move, path) for path in move.paths)
        moves.append(move)
    # After the per-source loop rather than inside it, which is git's
    # order and observable twice over: a source with a fault of its own
    # outranks this, and so does a same-target collision anywhere on
    # the line. ``-k`` does not reach it, since an overlap is not a
    # rename this source could survive being skipped for: moving the
    # directory first is what makes the other source disappear.
    overlap = overlapping(moves)
    if overlap is not None:
        raise MoveOverlapError(overlap[0], overlap[1])
    return moves


async def apply(dispatch: DispatchFn, location: RepoLocation,
                state: IndexState, move: Move, force: bool) -> None:
    """Make one move in the working tree and the index.

    The working tree moves first, through the mount's own rename so a
    directory carries its untracked files along, and the index entries
    are re-keyed with their blob ids and modes untouched. That is what
    lets ``status`` read the result as a rename rather than a delete
    beside an add.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        state (IndexState): the index, updated in place.
        move (Move): the move to make.
        force (bool): whether ``-f`` was given, which removes a file
            already at the destination first.
    """
    source = posixpath.join(location.worktree, move.source)
    destination = posixpath.join(location.worktree, move.destination)
    if force and not move.directory:
        await remove_file(dispatch, destination)
    try:
        await rename_path(dispatch, source, destination)
    except MISS_ERRORS as exc:
        raise RenameFailedError(move.source) from exc
    for path in move.paths:
        entry = state.entries.pop(path.encode())
        landing = moved_path(move, path).encode()
        state.entries[landing] = entry
        # The stages of whatever was standing at the destination go
        # with it. ``-f`` is the only way to reach an occupied
        # destination, and git's own answer there is one stage-0 entry
        # holding the source: ``ls-files -u`` is empty afterwards.
        # Leaving them is not a smaller divergence but a worse one,
        # since write_index lays the stages back over the entry and the
        # moved blob is the copy that disappears. Pinned against git
        # 2.50.1.
        state.conflicts.pop(landing, None)


async def mv(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Move or rename a file or directory, and stage the move.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    stat_path = doors.stat_path
    texts = inv.texts
    fl = FlagView(inv.flags)
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError, escaped(inv.argv),
                       switches(inv))
        flags = parse_flags(fl)
        if len(texts) < 2:
            raise MoveUsageError()
        repo, location = await opened(fl, doors)
        state = await read_index(dispatch, location.gitdir)
        conflicted = {
            path.decode("utf-8", errors="replace")
            for path in state.conflicts
        }
        # An unmerged path holds no ordinary entry, so a tracked set
        # built from the entries alone would call it untracked and let
        # a directory holding one move with its stages left behind.
        tracked = {
            path.decode("utf-8", errors="replace")
            for path in state.entries
        } | conflicted
        moves = await plan(stat_path,
                           links_of(doors), mounts_of(doors), location,
                           start_point(fl), texts, tracked, conflicted, flags)
        lines: list[str] = []
        if flags.dry_run:
            lines.extend(f"Checking rename of '{move.source}' to "
                         f"'{move.destination}'" for move in moves)
        if flags.verbose:
            lines.extend(f"Renaming {move.source} to {move.destination}"
                         for move in moves)
        if not flags.dry_run:
            for move in moves:
                await apply(dispatch, location, state, move, flags.force)
            await write_index(dispatch, location.gitdir, state)
    except GitError as exc:
        return fatal(exc)
    if not lines:
        return None, IOResult()
    return yield_bytes("".join(f"{line}\n"
                               for line in lines).encode()), IOResult()
