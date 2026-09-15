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
from dulwich.objects import Blob, Commit, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.branch import head_commit
from mirage.commands.cli.builtin.git.changes import (ADDED, DELETED, MODIFIED,
                                                     head_entries,
                                                     work_changes)
from mirage.commands.cli.builtin.git.constants import GITLINK, HEAD
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    BadStartPointError, BranchExistsError, CheckoutConflictError, GitError,
    NoWorkspaceError, RefLockError, UnknownPathspecError, UnknownSwitchError)
from mirage.commands.cli.builtin.git.format import short, subject
from mirage.commands.cli.builtin.git.index import (read_index,
                                                   refuse_unresolved,
                                                   write_index)
from mirage.commands.cli.builtin.git.io import (  # yapf: disable
    blocking_ancestor, drop_gitlink, keep_gitlink, refuse_replaced_mounts,
    remove_empty_parents, remove_file, remove_tree, restore_entry)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.pathspec import under
from mirage.commands.cli.builtin.git.reflog import record
from mirage.commands.cli.builtin.git.refs import (BRANCH_PREFIX, blocking_ref,
                                                  detach_head, read_head,
                                                  set_head, write_ref)
from mirage.commands.cli.builtin.git.reset import restored
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (HeadMove, HeadRef,
                                                   RepoLocation)
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal, links_of, mounts_of, switches)
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_ALL, scan
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import FileType

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


def flat_tree(repo: BaseRepo, tree_id: ObjectID) -> Tree:
    """Every path one tree holds, with its mode and blob id.

    Synchronous, and called on a worker thread: reading a tree pulls
    objects through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        tree_id (ObjectID): the tree to read.
    """
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(repo.object_store, tree_id)
    }


def tree_of(repo: BaseRepo, commit_id: ObjectID) -> Tree:
    """Every path a commit's tree holds, with its mode and blob id.

    Args:
        repo (BaseRepo): the opened repository.
        commit_id (ObjectID): the commit to read.
    """
    return flat_tree(repo, parse_commit(repo, commit_id).tree)


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


def _tree_names(tree: Tree) -> set[str]:
    """The paths a tree records, as text.

    Args:
        tree (Tree): a flattened tree, keyed by encoded path.
    """
    return {name.decode("utf-8", errors="replace") for name in tree}


def _written(before: Tree, after: Tree) -> Tree:
    """The entries a switch actually writes into the working tree.

    Every check that asks what is standing in the way has to ask about
    these rather than about the whole target tree. A path both trees
    record identically is never written, so an untracked file sitting on
    it is left exactly where it is; that file is one the index staged a
    deletion for, and git carries the staged deletion rather than
    refusing the switch over the copy left on disk. Content does not
    enter into it from the other side either: a path only the target
    records is refused even when the untracked copy already matches it
    byte for byte. Pinned against git 2.50.1.

    Args:
        before (Tree): the tree HEAD records.
        after (Tree): the tree being switched to.
    """
    return {
        path: entry
        for path, entry in after.items() if before.get(path) != entry
    }


def _overwritten(writing: Tree, untracked: list[str]) -> list[str]:
    """Which untracked files the entries being written would write over.

    An untracked file is in neither tree and neither index, so the
    comparison above cannot see it, and writing the target branch's blob
    over it destroys the only copy there is. git refuses and names each
    one. An ignored file is not in this list and git overwrites it
    silently, which is the same split. Pinned against git 2.50.

    Equality is not the whole test. An untracked file ``slot`` is also
    in the way of a target that records ``slot/child``, because the
    directory cannot be created without deleting it; git names the
    untracked file itself there, not the entry that needs the room.

    Args:
        writing (Tree): the entries the switch writes, from ``_written``.
        untracked (list[str]): every untracked path the walk found.
    """
    names = _tree_names(writing)
    return sorted(path for path in untracked
                  if path in names or any(under(name, path) for name in names))


def _blocked_ancestors(writing: Tree, dirty: set[str]) -> list[str]:
    """Which uncommitted paths stand where a written entry needs a directory.

    The same shape as the untracked check above, over the other set: an
    index entry at ``slot`` is in the way of a target recording
    ``slot/child``, because the directory cannot be created without
    removing the file. The exact-key comparison cannot see it, since
    ``slot`` is in neither tree.

    Deliberate divergence, and the same trade the staged case above
    makes. git allows this and discards the staged addition in silence:
    ``git switch`` onto a branch recording ``slot/child`` with ``slot``
    staged succeeds, replaces the file with the directory and leaves a
    clean status, with the staged blob reachable from nothing. Where the
    working tree *also* differs from the index git refuses instead,
    filed oddly under its untracked wording. mirage refuses both and
    names the path: there is no reflog here to recover a staged blob
    from, and a refusal the caller can act on beats a silent discard.
    Pinned against git 2.50.1.

    Args:
        writing (Tree): the entries the switch writes, from ``_written``.
        dirty (set[str]): paths whose working tree or index differs from
            HEAD.
    """
    names = _tree_names(writing)
    return sorted(path for path in dirty if any(
        under(name, path) for name in names))


def _blocked_descendants(writing: Tree, dirty: set[str]) -> list[str]:
    """Which uncommitted paths a written file's directory would take with it.

    The other half of the check above, over the same set. A staged
    ``slot/child`` is in the way of a target recording the *file*
    ``slot``, because the file cannot be written without removing the
    directory, and the index entry for the child would survive the
    switch as one half of a shape git's index has no room for. The
    exact-key comparison misses it for the same reason as the ancestor
    case: ``slot/child`` is in neither tree.

    The same deliberate divergence, and named the same way. git allows
    it: switching onto a branch recording the file ``slot`` with
    ``slot/child`` staged succeeds, removes the directory, and drops
    the staged entry with nothing left pointing at its blob. mirage
    refuses and names the path instead. Pinned against git 2.50.1.

    Args:
        writing (Tree): the entries the switch writes, from ``_written``.
        dirty (set[str]): paths whose working tree or index differs from
            HEAD.
    """
    names = _tree_names(writing)
    return sorted(path for path in dirty if any(
        under(path, name) for name in names))


def _lost_directories(writing: Tree, untracked: list[str]) -> list[str]:
    """Which directories the switch would empty of untracked files.

    The mirror of the case above: the target records a *file* where the
    working tree has a directory, so writing it means removing the
    directory, and anything untracked inside it is gone. git words this
    one differently and names the directory rather than the files, since
    the directory is what the caller has to move. Pinned against git
    2.50.1.

    A gitlink is not one of those entries. It asks for a directory, not
    for a file, so an existing one is left standing with everything in
    it, and git takes this switch rather than refusing it. Pinned
    against git 2.50.1; an untracked *file* at the same name is still
    refused, by the check above, because the directory cannot be made
    without deleting it.

    Args:
        writing (Tree): the entries the switch writes, from ``_written``.
        untracked (list[str]): every untracked path the walk found.
    """
    replacing = _tree_names({
        path: entry
        for path, entry in writing.items() if entry[0] != GITLINK
    })
    return sorted(name for name in replacing if any(
        under(path, name) for path in untracked))


async def _switch(dispatch: DispatchFn, stat_path: StatPath, repo: BaseRepo,
                  location: RepoLocation, before: Tree, after: Tree,
                  links: LinkView | None,
                  mounts: MountView | None) -> list[str]:
    """Make the working tree and index match the tree being switched to.

    Only paths the two trees disagree about are touched, so a file that
    is the same on both branches keeps whatever the working tree has,
    including an uncommitted edit, and keeps its index entry, which is
    what preserves a staged change both branches happen to agree about.
    Every path the trees do disagree about has already been refused by
    the caller if anything uncommitted stands on it, so the tree diff is
    the whole decision here.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): the data plane's stat, which dereferences.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        before (Tree): the tree HEAD records.
        after (Tree): the tree being switched to.
        links (LinkView | None): the name plane's link facts, so an
            entry that changes between a link and a file replaces what
            is there rather than writing through it.
        mounts (MountView | None): the name plane's mount boundaries,
            so a directory holding a nested mount is refused rather
            than emptied of a backend no branch recorded.
    """
    state = await read_index(dispatch, location.gitdir)
    state.conflicts.clear()
    changed = sorted(_written(before, after))
    # A gitlink is not written into the working tree at all, so it is
    # neither read as a blob nor allowed to clear what stands at the
    # name; keep_gitlink is the whole of what the entry asks for.
    replacing = [path for path in changed if after[path][0] != GITLINK]
    # Before the first removal, not at the entry that meets it: a
    # refusal halfway through leaves the entries already written
    # holding the target's content while HEAD and the index still name
    # the branch being left, which is the half-switch every other check
    # above exists to prevent.
    await refuse_replaced_mounts(
        stat_path, location.worktree,
        [path.decode("utf-8", errors="replace")
         for path in replacing], links, mounts)
    blobs = await asyncio.to_thread(contents, repo,
                                    [after[path][1] for path in replacing])
    # Removals first, and the emptied directories with them, because
    # the two sets name the same place whenever a branch records a file
    # where the other records a directory: writing ``slot/child`` while
    # the file ``slot`` is still there fails, and so does writing the
    # file while the directory is. Nothing is read back from the
    # working tree, so emptying it first is free. ``restore`` orders
    # its own pass the same way, for the same reason.
    notes: list[str] = []
    for path in sorted(set(before) - set(after)):
        name = path.decode("utf-8", errors="replace")
        where = posixpath.join(location.worktree, name)
        # A gitlink the target tree drops is a directory, not a file:
        # git rmdirs it and warns rather than failing when something is
        # still in it, where the unlink here died on it with the
        # removals ahead of it already applied.
        if before[path][0] == GITLINK:
            warned = await drop_gitlink(dispatch, stat_path, where, name,
                                        links)
            if warned is not None:
                notes.append(warned)
        else:
            await remove_file(dispatch, where)
        await remove_empty_parents(dispatch, where, location.worktree, mounts)
    for path in changed:
        name = path.decode("utf-8", errors="replace")
        mode, sha = after[path]
        if mode == GITLINK:
            await keep_gitlink(dispatch, stat_path,
                               posixpath.join(location.worktree, name), links)
            continue
        # Whatever the removals above did not take, a component above
        # the entry may still not be a directory: an ignored file or
        # link is in neither tree and in no collision list, so it
        # reaches here. git replaces it with the directory the entry
        # needs rather than writing through it, which is what keeps a
        # link's target tree, a path no branch named, out of the way.
        above = await blocking_ancestor(stat_path, location.worktree, name,
                                        links)
        if above is not None:
            await remove_file(dispatch, above)
        where = posixpath.join(location.worktree, name)
        # And the same thing standing on the name itself rather than
        # above it: a directory holding only ignored files is in no
        # collision list either, since the check that refuses one is
        # about the untracked files it would lose. git updates ignored
        # files by default and takes the whole directory with it. A
        # link is left to restore_entry, which retargets it; following
        # one to a directory here would delete a tree no branch named.
        if links is None or links.stat_at(where) is None:
            info = await stat_path(where)
            if info is not None and info.type is FileType.DIRECTORY:
                await remove_tree(dispatch, where, links, mounts)
        await restore_entry(dispatch, where, mode, blobs[sha], links)
    # The index is git's two-way merge, not a copy of the target tree:
    # only a path the two trees disagree about is decided by the
    # target, and where they agree the entry is left exactly as it
    # stands. That is what carries all three kinds of staged work
    # across. Rebuilding the index from the target alone dropped a
    # staged addition, which is in neither tree, and resurrected a
    # staged deletion, which is in both and in no entry, turning both
    # into unstaged changes a later commit would silently omit.
    for path in changed:
        mode, sha = after[path]
        state.entries[path] = restored(ObjectID(sha), mode)
    for path in set(before) - set(after):
        state.entries.pop(path, None)
    await write_index(dispatch, location.gitdir, state)
    return notes


def previous_position(repo: BaseRepo, head: HeadRef) -> str:
    """git's line for leaving a detached HEAD, empty when it was on a branch.

    Printed before the line saying where HEAD went, because a commit made
    while detached is reachable from nothing once HEAD moves, and this is
    the one place its id is still written down for the caller.

    Args:
        repo (BaseRepo): the opened repository.
        head (HeadRef): what HEAD pointed at before the move.
    """
    if head.commit is None:
        return ""
    commit = repo.object_store[ObjectID(head.commit.encode())]
    if not isinstance(commit, Commit):
        return ""
    return (f"Previous HEAD position was "
            f"{short(commit.id, abbrev_for(repo))} {subject(commit)}\n")


async def _attach(dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation,
                  head: HeadRef, commit: Commit, target: str, ref: Ref | None,
                  creating: bool) -> None:
    """Point HEAD at a commit and write the reflog line for the move.

    The half of a checkout that happens whatever the working tree
    holds: a branch created where HEAD already is does only this.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD pointed at before the move.
        commit (Commit): the commit HEAD is moving to.
        target (str): the operand as the user spelled it, for the
            reflog.
        ref (Ref | None): the branch to attach HEAD to, None to detach
            it at the commit.
        creating (bool): whether ``ref`` is a new branch to write first.
    """
    if creating and ref is not None:
        await write_ref(dispatch, location.commondir, ref.decode(), commit.id)
    if ref is not None:
        await set_head(dispatch, location.gitdir, ref.decode())
    else:
        await detach_head(dispatch, location.gitdir, commit.id)
    where = head.branch if head.branch is not None else short(
        (head.commit or "").encode(), abbrev_for(repo))
    await record(dispatch, location.gitdir,
                 ref.decode() if ref is not None else None,
                 head_commit(repo,
                             head), commit.id, IDENTITY, int(time.time()),
                 f"checkout: moving from {where} to {target}")


def _stage_letters(before: Tree, entries: dict[bytes,
                                               IndexEntry]) -> dict[str, str]:
    """How the index differs from HEAD, one status letter per path.

    The same three comparisons ``status`` makes against HEAD, kept
    here rather than borrowed from ``stage_changes`` because that one
    pairs renames and this list does not: git letters a carried change
    by what it is on its own, and an unmerged path cannot reach this
    (the caller refuses one before any tree is read).

    A path the index has no entry for is the one git's own reading gets
    right and a walk of the entries cannot see at all: a staged
    deletion is an absence, so it has to be read off HEAD's tree.

    Args:
        before (Tree): the tree HEAD records.
        entries (dict[bytes, IndexEntry]): the index as it stands.
    """
    letters: dict[str, str] = {}
    for path, entry in entries.items():
        name = path.decode("utf-8", errors="replace")
        recorded = before.get(path)
        if recorded is None:
            letters[name] = ADDED
        elif recorded != (entry.mode, entry.sha):
            letters[name] = MODIFIED
    for path in before:
        if path not in entries:
            letters[path.decode("utf-8", errors="replace")] = DELETED
    return letters


async def move_head(dispatch: DispatchFn, stat_path: StatPath,
                    links: LinkView | None, mounts: MountView | None,
                    repo: BaseRepo, location: RepoLocation, head: HeadRef,
                    commit: Commit, target: str, ref: Ref | None,
                    creating: bool, in_place: bool) -> HeadMove:
    """Move HEAD, the index and the working tree to a commit.

    The one procedure ``checkout`` and ``switch`` share, since the two
    differ only in what they accept and how they word a miss. Refuses
    rather than overwriting when the move would destroy work that is
    not committed, whether that is an edit to a tracked file, an
    untracked file the target holds, or a conflict still being
    resolved. Those checks are the whole reason either verb is safe to
    offer: without them a branch switch silently throws away whatever
    was changed and not staged, and there is no reflog here to get it
    back from.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        links (LinkView | None): the name plane's link facts, None
            outside a workspace.
        mounts (MountView | None): the name plane's mount boundaries,
            None outside a workspace.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD pointed at before the move.
        commit (Commit): the commit to move to.
        target (str): the operand as the user spelled it, for the
            reflog.
        ref (Ref | None): the branch to attach HEAD to, None to detach
            it at the commit.
        creating (bool): whether ``ref`` is a new branch to write first.
        in_place (bool): whether the line named no start point, so the
            new branch is being created where HEAD already is.

    Returns:
        HeadMove: the paths whose uncommitted change was carried across,
        and any warning the removals could not avoid.
    """
    # A branch created where HEAD already is moves nothing: git writes
    # the ref, points HEAD at it, and never touches the working tree or
    # the index, so an unmerged index survives ``git switch -c topic``
    # and is refused by ``git switch -c topic HEAD`` a word later. The
    # shape of the line is what decides it, which is git's own reading
    # rather than a comparison of the two trees. Pinned against git
    # 2.50.1.
    if in_place:
        await _attach(dispatch, repo, location, head, commit, target, ref,
                      creating)
        return HeadMove({}, "")
    before = await asyncio.to_thread(head_entries, repo) or {}
    after = await asyncio.to_thread(tree_of, repo, commit.id)
    state = await read_index(dispatch, location.gitdir)
    # First, before either tree is compared and before the working tree
    # is walked, which is where git refuses it too. Every check below
    # reads stage 0, so a path held only as conflict stages is invisible
    # to all of them and the move would clear the stages and delete the
    # file, throwing away a resolution in progress.
    refuse_unresolved(state)
    tracked = {
        path.decode("utf-8", errors="replace")
        for path in state.entries
    }
    # UNTRACKED_ALL, not the mode status uses: "normal" collapses a
    # wholly untracked directory to one ``dir/`` entry, and a
    # collision has to be decided per file. git names the file
    # inside such a directory, so the list has to hold it.
    found = await scan(dispatch, stat_path, location, tracked, UNTRACKED_ALL,
                       links)
    unstaged = await work_changes(dispatch, location.worktree, state.entries,
                                  found)
    staged = _stage_letters(before, state.entries)
    # Both kinds of uncommitted change count: an edit in the working
    # tree, and one already staged. Leaving the staged ones out is
    # what silently threw them away. The index column wins where a path
    # has both, which is how git's own short status reads a row and how
    # it letters this list.
    carried = dict(unstaged) | staged
    dirty = set(carried)
    writing = _written(before, after)
    blocked = sorted(
        set(_conflicts(before, after, dirty))
        | set(_blocked_ancestors(writing, dirty))
        | set(_blocked_descendants(writing, dirty)))
    overwritten = _overwritten(writing, found.untracked)
    lost = _lost_directories(writing, found.untracked)
    if blocked or overwritten or lost:
        raise CheckoutConflictError(blocked, overwritten, lost)
    notes = await _switch(dispatch, stat_path, repo, location, before, after,
                          links, mounts)
    await _attach(dispatch, repo, location, head, commit, target, ref,
                  creating)
    return HeadMove(carried, "".join(notes))


async def checkout(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Switch the working tree to another branch or commit.

    Refuses rather than overwriting when the switch would destroy work
    that is not committed; see ``move_head``, which does the moving for
    ``switch`` as well.

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
        check_operands(texts, UnknownSwitchError, escaped(inv.argv),
                       switches(inv))
        if not texts:
            raise UnknownPathspecError("")
        target = texts[0]
        repo, location = await opened(fl, doors)
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
            # The shortcut moves nothing, and that is exactly why it
            # has to read the index: git refuses the line over an
            # unresolved index rather than answering that there is
            # nothing to do, so a caller cannot read "Already on" as
            # proof the repository is in a state it can build on.
            refuse_unresolved(await read_index(dispatch, location.gitdir))
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
        # Before the working tree moves, which is where git refuses it
        # too: the ref is locked first and nothing is checked out when
        # the lock cannot be taken.
        held = blocking_ref(known, ref.decode()) if creating else None
        if held is not None:
            raise RefLockError(ref.decode(), held)
        attached = creating or ref in known
        moved = await move_head(dispatch, stat_path, links_of(doors),
                                mounts_of(doors), repo, location, head, commit,
                                target, ref if attached else None, creating,
                                creating and start is None)
    except GitError as exc:
        return fatal(exc)
    carried = "".join(f"{letter}\t{path}\n"
                      for path, letter in sorted(moved.carried.items()))
    # git writes the warning above everything it says about the move,
    # because the directory it could not remove is a fact about the
    # working tree rather than about where HEAD went.
    note = moved.warnings + previous_position(repo, head)
    if attached:
        verb = "Switched to a new branch" if creating else "Switched to branch"
        note += f"{verb} '{target}'\n"
    else:
        note += (f"Note: switching to '{target}'.\n\n{DETACHED_ADVICE}\n"
                 f"HEAD is now at {short(commit.id, abbrev_for(repo))} "
                 f"{subject(commit)}\n")
    return yield_bytes(carried.encode()), IOResult(stderr=note.encode())
