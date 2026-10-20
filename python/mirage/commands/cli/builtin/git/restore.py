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
from collections.abc import Sequence
from dataclasses import dataclass

from dulwich.index import IndexEntry
from dulwich.objects import Commit, ObjectID
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.changes import head_entries
from mirage.commands.cli.builtin.git.constants import GITLINK, HEAD
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    NoRestorePathsError,
    NoWorkspaceError,
    UnknownPathspecError,
    UnmergedPathError,
    UnreadableTreeError,
    UnresolvableSourceError,
)
from mirage.commands.cli.builtin.git.index_file import read_index, write_index
from mirage.commands.cli.builtin.git.io import (
    blocking_ancestor,
    drop_gitlink,
    is_link,
    keep_gitlink,
    read_names,
    read_optional,
    refuse_replaced_mounts,
    remove_empty_parents,
    remove_file,
    remove_tree,
    restore_entry,
    stat_of,
)
from mirage.commands.cli.builtin.git.pathspec import (
    decoded,
    matched,
    repo_relative,
    under,
    visible_entries,
)
from mirage.commands.cli.builtin.git.refs import BRANCH_PREFIX
from mirage.commands.cli.builtin.git.reset import restored
from mirage.commands.cli.builtin.git.revparse import (
    TREE,
    resolve_object,
    unwrapped,
)
from mirage.commands.cli.builtin.git.seen import check_rules
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.tree import (
    Tree,
    commit_entries,
    contents,
    tree_entries,
)
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    start_point,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.remnants import entry_name
from mirage.workspace.files import Files


@dataclass(frozen=True, slots=True)
class RestoreFlags:
    """The parsed shape of a ``git restore`` invocation.

    Args:
        staged (bool): ``--staged``, put the index back.
        worktree (bool): ``--worktree``, put the working tree back. The
            default when ``--staged`` is absent, which is git's rule.
        source (str | None): ``--source``, the tree to restore from.
            None means the index for the working tree and HEAD for the
            index.
    """

    staged: bool
    worktree: bool
    source: str | None


def parse_flags(fl: FlagView) -> RestoreFlags:
    """Read the raw restore flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    staged = fl.as_bool("staged")
    return RestoreFlags(
        staged=staged,
        worktree=fl.as_bool("worktree") or not staged,
        source=fl.as_str("source"),
    )


def index_tree(entries: dict[bytes, IndexEntry]) -> Tree:
    """The index read as a tree: every path with its mode and blob id.

    Args:
        entries (dict[bytes, IndexEntry]): the index.
    """
    return {path: (entry.mode, entry.sha) for path, entry in entries.items()}


def source_tree(repo: BaseRepo, revision: str) -> tuple[bytes, Tree]:
    """Every path a ``--source`` names, commit-ish or tree-ish.

    git takes any tree-ish here, and the option's own help says so
    (``--source <tree-ish>``), so the whole object grammar is legal:
    a branch, a raw tree id, a peel (``HEAD^{tree}``, ``v1^{tree}``)
    and a subtree at a path (``HEAD:sub``) all name a tree.

    The two refusals are worded differently because they are different
    complaints. A spelling that resolves to nothing is reported by the
    spelling; one that resolves to an object which is no tree is
    reported by the id it reached, since the name was fine and the
    object was not.

    Args:
        repo (BaseRepo): the opened repository.
        revision (str): the source as the user spelled it.
    """
    try:
        found = resolve_object(repo, revision)
    except GitError as exc:
        raise UnresolvableSourceError(revision) from exc
    # A local branch of that name wins over every other reading, as it
    # does for checkout's own operand: ``--source=main`` reads the
    # branch even where a tag ``main`` is what rev-parse would answer
    # (pinned against git 2.50.1).
    branch = Ref(f"{BRANCH_PREFIX}{revision}".encode())
    if branch in repo.refs.allkeys():
        found = repo[repo.refs[branch]]
    # A bare id names the object itself, so an annotated tag arrives as
    # the tag rather than as what it points at. A tag is no tree-ish,
    # and unwrapping it is what makes ``--source=<tag-id>`` read the
    # same tree ``--source=v1`` reads.
    found = unwrapped(repo, found, revision)
    if isinstance(found, Commit):
        # git's one implicit peel: a commit stands for its tree here.
        return found.tree, commit_entries(repo, found.id)
    if found.type_name.decode() != TREE:
        raise UnreadableTreeError(found.id.decode())
    return found.id, tree_entries(repo, found.id)


async def restore(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Put paths back to what a source records.

    Two targets and one source, git's own model. ``--staged`` restores
    the index and ``--worktree`` the working tree; the default is the
    working tree alone. The source is the index for the working tree
    and HEAD for the index unless ``--source`` names a tree, in which
    case a selected path the source does not hold is removed from
    whichever target is being restored, since that is what "make it
    match the source" means for it. Pinned against git 2.50.1.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = ctx.vfs
    fl = FlagView(ctx.flags)
    notes: list[str] = []
    try:
        if vfs is None:
            raise NoWorkspaceError()
        check_switches(ctx, texts)
        if not texts:
            raise NoRestorePathsError()
        flags = parse_flags(fl)
        repo, location = await opened(ctx, fl, work_tree=True)
        source: Tree | None
        if flags.source is not None:
            _, source = await asyncio.to_thread(
                source_tree, repo, flags.source
            )
        elif flags.staged:
            # Before the first commit there is no HEAD to restore the
            # index from, and reading that as an empty tree unstaged
            # every selected path and reported success. git refuses the
            # whole line instead, index untouched. The working tree
            # restores from the index, so it is only the implicit HEAD
            # source that has nothing to read: ``--source`` naming a
            # tree still works in the same repository.
            found = await asyncio.to_thread(head_entries, repo)
            if found is None:
                raise UnresolvableSourceError(HEAD)
            source = found
        else:
            source = None
        notes, _ = await restore_paths(
            ctx,
            repo,
            location,
            texts,
            start_point(fl).virtual,
            source,
            flags.staged,
            flags.worktree,
            False,
        )
    except GitError as exc:
        return fatal(exc)
    told = "".join(notes).encode()
    return None, IOResult(stderr=told) if told else IOResult()


async def refuse_ruled(
    vfs: Files,
    location: RepoLocation,
    replacing: Sequence[str],
    dropped: Sequence[str],
) -> None:
    """Ask the running command's rules about everything the working-tree
    pass writes or removes, before anything is: each entry restored or
    dropped, a non-directory standing in a restored entry's way, and
    every name under a directory a restored file replaces.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        replacing (Sequence[str]): the entries written.
        dropped (Sequence[str]): the entries removed.

    Raises:
        PolicyDenied: a rule refuses one of them.
    """
    for name in (*replacing, *dropped):
        check_rules(location, name)
    for name in replacing:
        above = await blocking_ancestor(vfs, location.worktree, name)
        if above is not None:
            check_rules(location, _relative(location, above))
            continue
        where = location.worktree.join(name)
        if not await is_link(vfs, where):
            await _refuse_ruled_under(vfs, location, where)


async def _refuse_ruled_under(
    vfs: Files, location: RepoLocation, path: PathSpec
) -> None:
    """Ask the rules about every name under a directory the restore
    removes whole, walked as ``remove_tree`` walks it: a link is not
    descended into, and a file lists as nothing below it.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        path (PathSpec): the directory, or whatever stands there.
    """
    for entry in await read_names(vfs, path):
        name = entry_name(entry)
        if not name:
            continue
        child = path.join(name)
        check_rules(location, _relative(location, child))
        if not await is_link(vfs, child):
            await _refuse_ruled_under(vfs, location, child)


def _relative(location: RepoLocation, path: PathSpec) -> str:
    """A working-tree path, repository-relative.

    Args:
        location (RepoLocation): the discovered repository.
        path (PathSpec): an absolute virtual path inside the work tree.
    """
    return posixpath.relpath(path.virtual, location.worktree.virtual)


async def restore_paths(
    ctx: Context,
    repo: BaseRepo,
    location: RepoLocation,
    operands: Sequence[str],
    start: str,
    source: Tree | None,
    staged: bool,
    worktree: bool,
    overlay: bool,
) -> tuple[list[str], int]:
    """Put selected paths back to what a source records: the work
    ``restore`` and ``checkout``'s path form share.

    Under ``overlay``, which is checkout's reading, a pathspec has to
    match the source and a path the index holds that the source does
    not is left as it is; without it, restore's own reading, such a
    path is removed.

    Args:
        ctx (Context): the line's context, whose files git writes.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        operands (Sequence[str]): the pathspecs as typed.
        start (str): the directory the line runs in.
        source (Tree | None): the tree to restore from, None for the
            index.
        staged (bool): put the index back.
        worktree (bool): put the working tree back.
        overlay (bool): checkout's reading of the pathspecs.

    Returns:
        tuple[list[str], int]: the warnings git prints, and how many
        working-tree files changed.
    """
    vfs = ctx.vfs
    if vfs is None:
        raise NoWorkspaceError()
    notes: list[str] = []
    updated = 0
    state = await read_index(vfs, location.gitdir)
    held = index_tree(state.entries)
    tree = held if source is None else source
    # The conflict stages name paths too. An unmerged path has no
    # stage-0 entry, so neither the index nor HEAD carries it and
    # the pathspec would miss what git matches: to git it is an
    # index entry like any other. Selecting it is what lets a
    # source holding it put it back, stages and all, and what lets
    # the refusal below name it when none does.
    names = (
        decoded(visible_entries(location, tree))
        if overlay and source is not None
        else decoded(visible_entries(location, held))
        | decoded(visible_entries(location, tree))
        | decoded(visible_entries(location, state.conflicts))
    )
    selected: set[str] = set()
    for operand in operands:
        hits = matched(names, repo_relative(location, start, operand))
        if not hits:
            raise UnknownPathspecError(operand)
        selected |= hits
    present = {name for name in selected if name.encode() in tree}
    absent = selected - present
    # A selected path the source does not hold and the index still
    # holds stages for cannot be restored either way: there is no
    # stage-0 content to write into the working tree and no entry
    # to stage. git names every one of them and does none of the
    # work, where an absent path with no stages is simply removed.
    unmerged = [name for name in absent if name.encode() in state.conflicts]
    if unmerged:
        raise UnmergedPathError(unmerged)
    # Before the index is written, not at the entry that meets it:
    # ``-SW`` stages first and restores after, so a refusal in the
    # working-tree pass would leave the index moved and the tree
    # exactly as it was, which is the one outcome this verb has no
    # wording for.
    # A gitlink is not written into the working tree at all, so it
    # is neither read as a blob nor allowed to clear what stands at
    # the name; keep_gitlink is the whole of what the entry asks
    # for, and the preflight has nothing to say about it either.
    replacing = sorted(
        name for name in present if tree[name.encode()][0] != GITLINK
    )
    # A gitlink's directory is not this verb's to empty either. The
    # entry is a placeholder for a repository mirage cannot read, so
    # git writes the directory and leaves every path under it alone:
    # a child the source drops loses its index entry and keeps its
    # working-tree copy, edits included. Removing it here is the one
    # loss nothing can undo, since the content was never staged.
    # Pinned against git 2.50.1.
    linked = [name for name in present if tree[name.encode()][0] == GITLINK]
    dropped = sorted(
        name
        for name in absent
        if not any(under(name, root) for root in linked)
    )
    if worktree:
        await refuse_replaced_mounts(vfs, location.worktree, replacing)
        # A rule refusing anything the working-tree pass writes or
        # removes is asked here too, so its refusal leaves the index as
        # it was.
        await refuse_ruled(vfs, location, replacing, dropped)
    if staged:
        for name in present:
            mode, sha = tree[name.encode()]
            state.entries[name.encode()] = restored(ObjectID(sha), mode)
        for name in absent:
            state.entries.pop(name.encode(), None)
        # A restored path is no longer unmerged, and saying so is
        # not optional: write_index lays the conflict stages over
        # the entries, so a stage left behind both keeps the path
        # conflicted and discards the entry just written for it.
        for name in selected:
            state.conflicts.pop(name.encode(), None)
        await write_index(vfs, location.gitdir, state)
    if worktree:
        blobs = await asyncio.to_thread(
            contents, repo, [tree[name.encode()][1] for name in replacing]
        )
        # Removals first, because the two sets can name the same
        # place: restoring a directory over a file writes
        # ``slot/child`` where the file ``slot`` still sits, and the
        # other direction writes the file where the directory still
        # sits. Nothing is read back from the working tree, so
        # emptying it first is free.
        for name in dropped:
            path = location.worktree.join(name)
            # A component above the entry that is not a directory
            # is not a way through to it: the unlink would resolve
            # past it and delete a file inside whatever it points
            # at, which no branch named. git checks the leading
            # path and removes nothing when it finds one, so
            # neither does this.
            if await blocking_ancestor(vfs, location.worktree, name):
                continue
            # What stands at a gitlink is a directory, so taking it
            # away is an rmdir that may legitimately fail: unlink
            # died on it with the index already written, which is
            # the half-restore this verb has no wording for.
            if held.get(name.encode(), (0, b""))[0] == GITLINK:
                warned = await drop_gitlink(vfs, path, name)
                if warned is not None:
                    notes.append(warned)
            else:
                await remove_file(vfs, path)
            await remove_empty_parents(vfs, path, location.worktree)
        for name in sorted(present):
            mode, sha = tree[name.encode()]
            where = location.worktree.join(name)
            if mode == GITLINK:
                await keep_gitlink(vfs, where)
                continue
            # The write direction takes the same component the
            # other way round: the entry needs a directory where it
            # stands, so git replaces it with one rather than
            # writing through it. A link's target tree is left
            # exactly as it was, and an untracked file standing
            # there is replaced in silence, which is what git does
            # to any leading non-directory.
            above = await blocking_ancestor(vfs, location.worktree, name)
            if above is not None:
                await remove_file(vfs, above)
            # A directory can still stand here after the loop
            # above: it removed the tracked children, but an
            # untracked one keeps it alive and the write would
            # fail on it with the index already updated. git
            # replaces the whole directory, untracked children
            # included. A link is left to restore_entry, which
            # retargets it; following one to a directory here
            # would delete a tree no branch named.
            current: bytes | None = None
            if not await is_link(vfs, where):
                info = await stat_of(vfs, where)
                if info is not None and info.type is FileType.DIRECTORY:
                    await remove_tree(vfs, where)
                elif info is not None and above is None:
                    current = await read_optional(vfs, where)
            if current != blobs[sha]:
                updated += 1
            await restore_entry(vfs, where, mode, blobs[sha])
    return notes, updated
