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

from dataclasses import dataclass

from dulwich.index import IndexEntry
from dulwich.objects import ObjectID

from mirage.commands.cli.builtin.git.constants import (
    EXECUTABLE,
    OWNER_EXECUTE,
    REGULAR,
    SYMLINK,
)
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    IgnoredPathsError,
    NothingSpecifiedError,
    NoWorkspaceError,
    PathspecError,
    UnknownPathspecError,
)
from mirage.commands.cli.builtin.git.ignore import IgnoreStack, load_ignores
from mirage.commands.cli.builtin.git.index_file import read_index, write_index
from mirage.commands.cli.builtin.git.io import entry_bytes
from mirage.commands.cli.builtin.git.objects import store_blob
from mirage.commands.cli.builtin.git.pathspec import (
    matched,
    repo_relative,
    visible_entries,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (
    IndexState,
    RepoLocation,
    WorkTree,
)
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    links_of,
    start_point,
)
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    scan,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType
from mirage.view.types import LinkView, StatPath


@dataclass(frozen=True, slots=True)
class AddFlags:
    """The parsed shape of a ``git add`` invocation.

    Args:
        every (bool): ``-A``, stage every change in the working tree.
        update (bool): ``-u``, stage changes to tracked files only.
        force (bool): ``-f``, stage a path an ignore rule covers.
        verbose (bool): ``-v``, name each path as it is staged.
    """

    every: bool
    update: bool
    force: bool
    verbose: bool = False


def parse_flags(fl: FlagView) -> AddFlags:
    """Read the raw add flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    return AddFlags(
        every=fl.as_bool("all"),
        update=fl.as_bool("update"),
        force=fl.as_bool("force"),
        verbose=fl.as_bool("verbose"),
    )


def entry_mode(info: FileStat) -> int:
    """The mode git would record for a working-tree file.

    Args:
        info (FileStat): what the mount says about the file.
    """
    if info.type is FileType.SYMLINK:
        return SYMLINK
    if info.mode is not None and info.mode & OWNER_EXECUTE:
        return EXECUTABLE
    return REGULAR


def staged_entry(sha: ObjectID, info: FileStat, size: int) -> IndexEntry:
    """An index entry for a file just written into the object database.

    The stat fields git caches to avoid re-hashing (device, inode,
    timestamps) are recorded as zero, because a mount serves none of
    them meaningfully. That is not a corrupt entry: it is exactly what
    git calls a smudged one, and the only consequence is that git
    re-hashes the file next time instead of trusting the cache. A wrong
    value there would be far worse, since git would trust it.

    Args:
        sha (bytes): the blob id that was written.
        info (FileStat): what the mount says about the file.
        size (int): the byte length actually staged.
    """
    return IndexEntry(
        ctime=0,
        mtime=0,
        dev=0,
        ino=0,
        mode=entry_mode(info),
        uid=0,
        gid=0,
        size=size,
        sha=sha,
    )


def keep_addable(
    paths: set[str], tracked: set[str], ignores: IgnoreStack
) -> set[str]:
    """Drop the paths an ignore rule covers, keeping tracked ones.

    Ignore rules govern untracked files only, so a file already in the
    index stays stageable however the rules read.

    Args:
        paths (set[str]): candidate paths, repository-relative.
        tracked (set[str]): paths the index already holds.
        ignores (IgnoreStack): the repository's ignore rules.
    """
    return {
        path
        for path in paths
        if path in tracked or not ignores.is_ignored(path)
    }


def _update_scope(
    location: RepoLocation,
    start: str,
    tracked: set[str],
    present: set[str],
    operands: tuple[str, ...],
) -> set[str]:
    """Which tracked paths ``-u`` operands select.

    ``-u`` restages what the index already holds, so an operand narrows
    that set rather than adding to it: an untracked file under one is
    still not staged. git tells two misses apart and so does this. An
    operand naming nothing at all is a fatal about the pathspec, and one
    naming something the working tree has but the index does not is a
    fatal about git not knowing it. Pinned against git 2.50.1.

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        tracked (set[str]): repository-relative paths the index holds.
        present (set[str]): repository-relative paths the walk found.
        operands (tuple[str, ...]): the pathspecs as typed.
    """
    selected: set[str] = set()
    for operand in operands:
        target = repo_relative(location, start, operand)
        hits = matched(tracked, target)
        if not hits and not matched(present, target):
            raise PathspecError(operand)
        if not hits:
            raise UnknownPathspecError(operand, fatal=True)
        selected |= hits
    return selected


async def _resolve(
    stat_path: StatPath,
    location: RepoLocation,
    start: str,
    operands: tuple[str, ...],
    found: WorkTree,
    tracked: set[str],
    ignores: IgnoreStack,
    force: bool,
) -> tuple[set[str], set[str]]:
    """Turn path operands into the paths to stage and to unstage.

    An operand that names nothing in either the working tree or the
    index is git's fatal. Naming an ignored file outright is a different
    refusal, and only applies when it is named outright: expanding a
    directory quietly leaves its ignored files alone, because asking for
    a directory is not asking for the things in it that were excluded.

    Args:
        stat_path (StatPath): dispatcher-backed stat, both channels.
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operands (tuple[str, ...]): the pathspecs as typed.
        found (WorkTree): what the walk of the working tree found.
        tracked (set[str]): repository-relative paths the index holds.
        ignores (IgnoreStack): the repository's ignore rules.
        force (bool): whether ``-f`` was given.
    """
    present = set(found.files)
    stage: set[str] = set()
    remove: set[str] = set()
    ignored: list[str] = []
    for operand in operands:
        target = repo_relative(location, start, operand)
        gone = matched(tracked, target) - present
        if target in present:
            if force or target in tracked or not ignores.is_ignored(target):
                stage.add(target)
            else:
                ignored.append(target)
            continue
        hits = matched(present, target)
        if hits or gone:
            stage |= hits if force else keep_addable(hits, tracked, ignores)
            remove |= gone
            continue
        info = await stat_path(location.worktree.join(target))
        if info is None or info.type is FileType.DIRECTORY:
            raise PathspecError(operand)
        found.files[target] = info
        stage.add(target)
    if ignored:
        raise IgnoredPathsError(ignored)
    return stage, remove


async def stage_changes(
    dispatch: DispatchFn,
    location: RepoLocation,
    state: IndexState,
    found: WorkTree,
    stage: set[str],
    remove: set[str],
) -> list[str]:
    """Hash the staged paths into the index and drop the removed ones.

    Returns what ``-v`` prints, in git's order: first the paths the
    index already held whose content or mode changed, a removal among
    them, then the new paths, each group sorted. A path restaged
    unchanged is not named (pinned against git 2.50).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        state (IndexState): the index, updated in place.
        found (WorkTree): what the walk of the working tree found.
        stage (set[str]): repository-relative paths to stage.
        remove (set[str]): repository-relative paths to unstage.
    """
    changed: list[tuple[str, str]] = []
    added: list[str] = []
    for path in sorted(stage):
        data = await entry_bytes(
            dispatch, location.worktree.join(path), found.files[path]
        )
        sha = await store_blob(dispatch, location.commondir, data)
        entry = staged_entry(sha, found.files[path], len(data))
        before = state.entries.get(path.encode())
        if before is None:
            added.append(path)
        elif (before.sha, before.mode) != (entry.sha, entry.mode):
            changed.append((path, "add"))
        state.entries[path.encode()] = entry
    for path in remove:
        state.entries.pop(path.encode(), None)
        changed.append((path, "remove"))
    return [f"{verb} '{path}'" for path, verb in sorted(changed)] + [
        f"add '{path}'" for path in added
    ]


async def stage_tracked(
    dispatch: DispatchFn,
    stat_path: StatPath,
    location: RepoLocation,
    state: IndexState,
    links: LinkView | None,
) -> None:
    """Restage every path the index holds from the working tree.

    What ``add -u`` does with no pathspec and ``commit -a`` does first:
    a modified file is hashed again, a deleted one leaves the index, and
    an untracked one stays untracked.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        location (RepoLocation): the discovered repository.
        state (IndexState): the index, updated in place.
        links (LinkView | None): the namespace's symlink table.
    """
    tracked = {
        path.decode("utf-8", errors="replace")
        for path in visible_entries(location, state.entries)
    }
    found = await scan(
        dispatch, stat_path, location, tracked, UNTRACKED_NO, links
    )
    present = set(found.files)
    await stage_changes(
        dispatch, location, state, found, tracked & present, tracked - present
    )


async def add(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Stage working-tree content into the index.

    Every path is hashed and written as a loose object, then recorded in
    the index. Staging a path that is gone records the removal instead,
    which is what makes ``git add <deleted>`` and ``git add -A`` stage a
    deletion without a separate verb.

    ``-A`` and ``-u`` both narrow to the pathspecs when any are given,
    and differ in what they will stage: ``-A`` takes untracked files
    too, ``-u`` only what the index already holds.

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
    flags = inv.flags
    fl = FlagView(flags)
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        check_switches(inv, texts)
        parsed = parse_flags(fl)
        if not texts and not parsed.every and not parsed.update:
            raise NothingSpecifiedError()
        _repo, location = await opened(fl, doors, work_tree=True)
        state = await read_index(dispatch, location.gitdir)
        tracked = {
            path.decode("utf-8", errors="replace")
            for path in visible_entries(location, state.entries)
        }
        found = await scan(
            dispatch,
            stat_path,
            location,
            tracked,
            UNTRACKED_ALL,
            links_of(doors),
        )
        ignores = await load_ignores(
            dispatch, location.commondir, location.worktree
        )
        if parsed.update:
            scope = (
                _update_scope(
                    location,
                    start_point(fl).virtual,
                    tracked,
                    set(found.files),
                    texts,
                )
                if texts
                else tracked
            )
            stage = scope & set(found.files)
            remove = scope - set(found.files)
        elif parsed.every and not texts:
            stage = keep_addable(set(found.files), tracked, ignores)
            remove = tracked - set(found.files)
        else:
            stage, remove = await _resolve(
                stat_path,
                location,
                start_point(fl).virtual,
                texts,
                found,
                tracked,
                ignores,
                parsed.force,
            )
        lines = await stage_changes(
            dispatch, location, state, found, stage, remove
        )
        await write_index(dispatch, location.gitdir, state)
    except GitError as exc:
        return fatal(exc)
    if not parsed.verbose or not lines:
        return None, IOResult()
    return yield_bytes(
        "".join(f"{line}\n" for line in lines).encode()
    ), IOResult()
