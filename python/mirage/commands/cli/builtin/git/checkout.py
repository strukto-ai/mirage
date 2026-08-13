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
import posixpath
import time

from dulwich.index import IndexEntry
from dulwich.object_store import iter_tree_contents
from dulwich.objects import Blob, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import head_entries, work_changes
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    BadStartPointError, BranchExistsError, CheckoutConflictError, GitError,
    NoWorkspaceError, UnknownPathspecError, UnknownSwitchError)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.index import read_index, write_index
from mirage.commands.cli.builtin.git.io import remove_file, write_file
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.reflog import record
from mirage.commands.cli.builtin.git.refs import (BRANCH_PREFIX, HEAD_REF,
                                                  detach_head, read_head,
                                                  set_head, write_ref)
from mirage.commands.cli.builtin.git.reset import restored
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import HEAD, check_operands, fatal
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_ALL, scan
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn

Tree = dict[bytes, tuple[int, bytes]]

# What checkout records in the reflog. There is no committer here, only
# a move of HEAD, so the same stated identity commit uses is reused.
IDENTITY = b"mirage <mirage@localhost>"

# git's word-for-word warning when HEAD leaves a branch, kept verbatim.
# It is the only thing telling a caller that commits made from here
# become unreachable once HEAD moves again, and an agent that has read
# this text before should not have to read a paraphrase of it.
DETACHED_ADVICE = """You are in 'detached HEAD' state. You can look around, \
make experimental
changes and commit them, and you can discard any commits you make in this
state without impacting any branches by switching back to a branch.

If you want to create a new branch to retain commits you create, you may
do so (now or later) by using -c with the switch command. Example:

  git switch -c <new-branch-name>

Or undo this operation with:

  git switch -

Turn off this advice by setting config variable advice.detachedHead to false
"""


def tree_of(repo: BaseRepo, commit_id: ObjectID) -> Tree:
    """Every path a commit's tree holds, with its mode and blob id.

    Synchronous, and called on a worker thread: reading a tree pulls
    objects through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        commit_id (ObjectID): the commit to read.
    """
    commit = parse_commit(repo, commit_id)
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(repo.object_store, commit.tree)
    }


def contents(repo: BaseRepo, shas: list[bytes]) -> dict[bytes, bytes]:
    """Fetch several blobs at once, off the event loop.

    Args:
        repo (BaseRepo): the opened repository.
        shas (list[bytes]): the blob ids to read.
    """
    out: dict[bytes, bytes] = {}
    for sha in shas:
        obj = repo.object_store[ObjectID(sha)]
        out[sha] = obj.data if isinstance(obj, Blob) else b""
    return out


def _conflicts(before: Tree, after: Tree, dirty: set[str]) -> list[str]:
    """Which uncommitted changes the switch would overwrite.

    A file edited but not committed survives a branch switch when both
    branches record the same content for it: git carries the edit
    across rather than refusing, and only refuses when the target
    branch would have to write over it. Pinned against git 2.47.

    Deliberate divergence for a *staged* change to such a file: git
    carries that across too, applying its own two-way merge to the
    index, and mirage refuses instead. Refusing is the safe half of the
    trade. Getting the merge wrong loses staged work with no reflog to
    recover it from, and a refusal that names the file is something the
    caller can act on, where a silent clobber is not.

    Args:
        before (Tree): the tree HEAD records.
        after (Tree): the tree being switched to.
        dirty (set[str]): paths whose working tree or index differs from
            HEAD.
    """
    return sorted(path for path in dirty
                  if before.get(path.encode()) != after.get(path.encode()))


def _overwritten(after: Tree, untracked: list[str]) -> list[str]:
    """Which untracked files the tree being switched to would write over.

    An untracked file is in neither tree and neither index, so the
    comparison above cannot see it, and writing the target branch's blob
    over it destroys the only copy there is. git refuses and names each
    one. An ignored file is not in this list and git overwrites it
    silently, which is the same split. Pinned against git 2.50.

    Args:
        after (Tree): the tree being switched to.
        untracked (list[str]): every untracked path the walk found.
    """
    return sorted(path for path in untracked if path.encode() in after)


async def _switch(dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation,
                  before: Tree, after: Tree, keep: set[str],
                  staged: dict[bytes, IndexEntry]) -> None:
    """Make the working tree and index match the tree being switched to.

    Only paths whose recorded content differs are touched, so a file
    that is the same on both branches keeps whatever the working tree
    has, including an uncommitted edit. A path carried across keeps its
    index entry too, which is what preserves a staged change that both
    branches happen to agree about.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        before (Tree): the tree HEAD records.
        after (Tree): the tree being switched to.
        keep (set[str]): paths whose working-tree copy must not be
            rewritten.
        staged (dict[bytes, IndexEntry]): the index as it stands, read
            for the entries of the paths being kept.
    """
    state = await read_index(dispatch, location.gitdir)
    state.entries.clear()
    state.conflicts.clear()
    changed = [
        path for path in after if before.get(path) != after[path]
        and path.decode("utf-8", errors="replace") not in keep
    ]
    blobs = await asyncio.to_thread(contents, repo,
                                    [after[path][1] for path in changed])
    for path in changed:
        name = path.decode("utf-8", errors="replace")
        await write_file(dispatch, posixpath.join(location.worktree, name),
                         blobs[after[path][1]])
    for path in set(before) - set(after):
        name = path.decode("utf-8", errors="replace")
        await remove_file(dispatch, posixpath.join(location.worktree, name))
    for path, (mode, sha) in after.items():
        name = path.decode("utf-8", errors="replace")
        held = staged.get(path)
        if name in keep and held is not None:
            state.entries[path] = held
        else:
            state.entries[path] = restored(ObjectID(sha), mode)
    await write_index(dispatch, location.gitdir, state)


async def checkout(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Switch the working tree to another branch or commit.

    Refuses rather than overwriting when the switch would destroy work
    that is not committed, whether that is an edit to a tracked file or
    an untracked file the target branch happens to hold. That check is
    the whole reason this verb is safe to offer: without it a branch
    switch silently throws away whatever was changed and not staged, and
    there is no reflog here to get it back from.

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
        if not texts:
            raise UnknownPathspecError("")
        target = texts[0]
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        head = await read_head(dispatch, location.gitdir)
        creating = fl.as_bool("b")
        ref = Ref(f"{BRANCH_PREFIX}{target}".encode())
        known = repo.refs.allkeys()
        if creating and ref in known:
            raise BranchExistsError(target)
        if not creating and ref not in known and target != head.branch:
            try:
                resolve_commit(repo, target)
            except GitError as exc:
                raise UnknownPathspecError(target) from exc
        if not creating and target == head.branch:
            return None, IOResult(stderr=f"Already on '{target}'\n".encode())
        # ``checkout -b <new> [<start>]`` branches from the start point
        # when one is given, HEAD otherwise. Forcing HEAD here put the new
        # branch on the current commit and dropped the operand without a
        # word, so every commit after it landed on the wrong history.
        start = texts[1] if creating and len(texts) > 1 else None
        if start is not None:
            try:
                commit = resolve_commit(repo, start)
            except GitError as exc:
                raise BadStartPointError(start, target) from exc
        else:
            commit = resolve_commit(repo, target if not creating else HEAD)
        before = await asyncio.to_thread(head_entries, repo) or {}
        after = await asyncio.to_thread(tree_of, repo, commit.id)
        state = await read_index(dispatch, location.gitdir)
        tracked = {
            path.decode("utf-8", errors="replace")
            for path in state.entries
        }
        # UNTRACKED_ALL, not the mode status uses: "normal" collapses a
        # wholly untracked directory to one ``dir/`` entry, and a
        # collision has to be decided per file. git names the file
        # inside such a directory, so the list has to hold it.
        found = await scan(dispatch, stat_path, location, tracked,
                           UNTRACKED_ALL)
        unstaged = await work_changes(dispatch, location.worktree,
                                      state.entries, found)
        # Both kinds of uncommitted change count: an edit in the working
        # tree, and one already staged. Leaving the staged ones out is
        # what silently threw them away.
        staged = {
            path.decode("utf-8", errors="replace")
            for path, entry in state.entries.items()
            if before.get(path) != (entry.mode, entry.sha)
        }
        dirty = set(unstaged) | staged
        blocked = _conflicts(before, after, dirty)
        overwritten = _overwritten(after, found.untracked)
        if blocked or overwritten:
            raise CheckoutConflictError(blocked, overwritten)
        await _switch(dispatch, repo, location, before, after, dirty,
                      state.entries)
        attached = creating or ref in known
        if creating:
            await write_ref(dispatch, location.commondir, ref.decode(),
                            commit.id)
        if attached:
            await set_head(dispatch, location.gitdir, ref.decode())
        else:
            await detach_head(dispatch, location.gitdir, commit.id)
        where = head.branch if head.branch is not None else short(
            (head.commit or "").encode(), abbrev_for(repo))
        await record(
            dispatch, location.gitdir,
            ref.decode() if attached else None,
            head.commit.encode() if head.commit else
            (repo.refs[HEAD_REF] if head.ref in known else None), commit.id,
            IDENTITY, int(time.time()),
            f"checkout: moving from {where} to {target}")
    except GitError as exc:
        return fatal(exc)
    carried = "".join(f"M\t{path}\n" for path in sorted(dirty))
    if attached:
        verb = "Switched to a new branch" if creating else "Switched to branch"
        note = f"{verb} '{target}'\n"
    else:
        subject = commit.message.decode(errors="replace").splitlines()[0]
        note = (f"Note: switching to '{target}'.\n\n{DETACHED_ADVICE}\n"
                f"HEAD is now at {short(commit.id, abbrev_for(repo))} "
                f"{subject}\n")
    return yield_bytes(carried.encode()), IOResult(stderr=note.encode())
