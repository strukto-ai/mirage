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

from dulwich.index import IndexEntry
from dulwich.objects import ObjectID

from mirage.commands.cli.builtin.git.errors import GitError  # yapf: disable
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    IgnoredPathsError, NothingSpecifiedError, NoWorkspaceError, PathspecError,
    UnknownPathspecError, UnknownSwitchError)
from mirage.commands.cli.builtin.git.ignore import IgnoreStack, load_ignores
from mirage.commands.cli.builtin.git.index import read_index, write_index
from mirage.commands.cli.builtin.git.io import read_file
from mirage.commands.cli.builtin.git.objects import store_blob
from mirage.commands.cli.builtin.git.pathspec import matched, repo_relative
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation, WorkTree
from mirage.commands.cli.builtin.git.util import (check_operands, fatal,
                                                  start_point)
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_ALL, scan
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import StatPath
from mirage.types import FileStat, FileType

# git records one of two modes for a regular file and reads only the
# owner execute bit to choose. A mount that reports no mode at all
# stages the ordinary one, which is what the file will read back as.
REGULAR = 0o100644
EXECUTABLE = 0o100755
OWNER_EXECUTE = 0o100


@dataclass(frozen=True, slots=True)
class AddFlags:
    """The parsed shape of a ``git add`` invocation.

    Args:
        every (bool): ``-A``, stage every change in the working tree.
        update (bool): ``-u``, stage changes to tracked files only.
        force (bool): ``-f``, stage a path an ignore rule covers.
    """
    every: bool
    update: bool
    force: bool


def parse_flags(fl: FlagView) -> AddFlags:
    """Read the raw add flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    return AddFlags(every=fl.as_bool("all"),
                    update=fl.as_bool("update"),
                    force=fl.as_bool("force"))


def entry_mode(info: FileStat) -> int:
    """The mode git would record for a working-tree file.

    Args:
        info (FileStat): what the mount says about the file.
    """
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
    return IndexEntry(ctime=0,
                      mtime=0,
                      dev=0,
                      ino=0,
                      mode=entry_mode(info),
                      uid=0,
                      gid=0,
                      size=size,
                      sha=sha)


def keep_addable(paths: set[str], tracked: set[str],
                 ignores: IgnoreStack) -> set[str]:
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
        for path in paths if path in tracked or not ignores.is_ignored(path)
    }


def _update_scope(location: RepoLocation, start: str, tracked: set[str],
                  present: set[str], operands: tuple[str, ...]) -> set[str]:
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


async def _resolve(stat_path: StatPath, location: RepoLocation, start: str,
                   operands: tuple[str, ...], found: WorkTree,
                   tracked: set[str], ignores: IgnoreStack,
                   force: bool) -> tuple[set[str], set[str]]:
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
        info = await stat_path(posixpath.join(location.worktree, target))
        if info is None or info.type is FileType.DIRECTORY:
            raise PathspecError(operand)
        found.files[target] = info
        stage.add(target)
    if ignored:
        raise IgnoredPathsError(ignored)
    return stage, remove


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
            git declares no config_model, and the workspace doors
            it reads (dispatch, stat_path, mount_root) ride
            ``inv.ops``.
    """
    ops = inv.ops or CLIVerbOpts()
    dispatch = ops.dispatch
    stat_path = ops.stat_path
    mount_root = ops.mount_root
    texts = inv.texts
    flags = inv.flags
    fl = FlagView(flags)
    try:
        if stat_path is None or mount_root is None or dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError)
        parsed = parse_flags(fl)
        if not texts and not parsed.every and not parsed.update:
            raise NothingSpecifiedError()
        _repo, location = await opened(fl, stat_path, mount_root, dispatch)
        state = await read_index(dispatch, location.gitdir)
        tracked = {
            path.decode("utf-8", errors="replace")
            for path in state.entries
        }
        found = await scan(dispatch, stat_path, location, tracked,
                           UNTRACKED_ALL)
        ignores = await load_ignores(dispatch, location.gitdir,
                                     location.worktree)
        if parsed.update:
            scope = (_update_scope(location, start_point(fl), tracked,
                                   set(found.files), texts)
                     if texts else tracked)
            stage = scope & set(found.files)
            remove = scope - set(found.files)
        elif parsed.every and not texts:
            stage = keep_addable(set(found.files), tracked, ignores)
            remove = tracked - set(found.files)
        else:
            stage, remove = await _resolve(stat_path, location,
                                           start_point(fl), texts, found,
                                           tracked, ignores, parsed.force)
        for path in sorted(stage):
            data = await read_file(dispatch,
                                   posixpath.join(location.worktree, path))
            sha = await store_blob(dispatch, location.commondir, data)
            state.entries[path.encode()] = staged_entry(
                sha, found.files[path], len(data))
        for path in remove:
            state.entries.pop(path.encode(), None)
        await write_index(dispatch, location.gitdir, state)
    except GitError as exc:
        return fatal(exc)
    return None, IOResult()
