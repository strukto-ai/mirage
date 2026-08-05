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

from dulwich.index import IndexEntry
from dulwich.objects import ObjectID
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import head_entries, work_changes
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    AmbiguousArgumentError, GitError, NoWorkspaceError, RevisionResetError,
    UnknownSwitchError)
from mirage.commands.cli.builtin.git.index import read_index, write_index
from mirage.commands.cli.builtin.git.pathspec import matched, repo_relative
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (check_operands, fatal,
                                                  start_point)
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_NO, scan
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

UNSTAGED_HEADER = "Unstaged changes after reset:"


def _unmatched(repo: BaseRepo, operand: str) -> GitError:
    """Which fatal an operand that selected no path deserves.

    Two different mistakes reach here and git words them differently. A
    typo names neither a revision nor a path, and git calls that
    ambiguous. A revision names something real that this build cannot
    reset to, and answering "unknown revision" for a revision it can
    resolve perfectly well would send the caller looking for the wrong
    problem.

    Args:
        repo (BaseRepo): the opened repository, for the revision lookup.
        operand (str): the operand as the user spelled it.
    """
    try:
        resolve_commit(repo, operand)
    except GitError:
        return AmbiguousArgumentError(operand)
    return RevisionResetError(operand)


def restored(sha: ObjectID, mode: int) -> IndexEntry:
    """An index entry putting a path back to what HEAD records.

    The stat fields are zeroed for the same reason staging zeroes them:
    a mount serves none of them meaningfully, and git reads a zeroed
    entry as one whose cache it should not trust rather than as a
    corrupt one.

    Args:
        sha (bytes): the blob id HEAD holds for the path.
        mode (int): the mode HEAD holds for it.
    """
    return IndexEntry(ctime=0,
                      mtime=0,
                      dev=0,
                      ino=0,
                      mode=mode,
                      uid=0,
                      gid=0,
                      size=0,
                      sha=sha)


async def reset(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Put the index back to what HEAD records, staging nothing.

    The working tree is never touched: this is ``git reset`` in its
    default mixed mode, which unstages. ``--hard`` is deliberately not
    offered, because it destroys uncommitted work and there is no
    reflog here to recover it from.

    A pathspec limits the reset to those paths, which is how a single
    file is unstaged.

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
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        state = await read_index(dispatch, location.gitdir)
        tree = await asyncio.to_thread(head_entries, repo) or {}
        start = start_point(fl)
        names = {path.decode("utf-8", errors="replace") for path in tree}
        names |= {
            path.decode("utf-8", errors="replace")
            for path in state.entries
        }
        if texts:
            selected: set[str] = set()
            for operand in texts:
                hits = matched(names, repo_relative(location, start, operand))
                if not hits:
                    raise _unmatched(repo, operand)
                selected |= hits
        else:
            selected = names
        for name in selected:
            key = name.encode()
            recorded = tree.get(key)
            if recorded is None:
                state.entries.pop(key, None)
            else:
                state.entries[key] = restored(ObjectID(recorded[1]),
                                              recorded[0])
        if not texts:
            state.conflicts.clear()
        await write_index(dispatch, location.gitdir, state)
        found = await scan(
            dispatch, stat_path, location,
            {path.decode("utf-8", errors="replace")
             for path in state.entries}, UNTRACKED_NO)
        unstaged = await work_changes(dispatch, location.worktree,
                                      state.entries, found)
    except GitError as exc:
        return fatal(exc)
    if not unstaged:
        return None, IOResult()
    lines = [UNSTAGED_HEADER]
    lines.extend(f"{letter}\t{path}"
                 for path, letter in sorted(unstaged.items()))
    return yield_bytes("".join(f"{line}\n"
                               for line in lines).encode()), IOResult()
