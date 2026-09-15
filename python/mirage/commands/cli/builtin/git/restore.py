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
from collections.abc import Iterable
from dataclasses import dataclass

from dulwich.index import IndexEntry
from dulwich.objects import Commit, ObjectID
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import head_entries
from mirage.commands.cli.builtin.git.checkout import (Tree, contents,
                                                      flat_tree, tree_of)
from mirage.commands.cli.builtin.git.constants import GITLINK, HEAD
from mirage.commands.cli.builtin.git.errors import GitError  # yapf: disable
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    NoRestorePathsError, NoWorkspaceError, UnknownPathspecError,
    UnknownSwitchError, UnmergedPathError, UnreadableTreeError,
    UnresolvableSourceError)
from mirage.commands.cli.builtin.git.index import read_index, write_index
from mirage.commands.cli.builtin.git.io import (  # yapf: disable
    blocking_ancestor, drop_gitlink, keep_gitlink, refuse_replaced_mounts,
    remove_empty_parents, remove_file, remove_tree, restore_entry)
from mirage.commands.cli.builtin.git.pathspec import (matched, repo_relative,
                                                      under)
from mirage.commands.cli.builtin.git.reset import restored
from mirage.commands.cli.builtin.git.revparse import (TREE, resolve_object,
                                                      unwrapped)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal, links_of, mounts_of, start_point, switches)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType


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
    return RestoreFlags(staged=staged,
                        worktree=fl.as_bool("worktree") or not staged,
                        source=fl.as_str("source"))


def index_tree(entries: dict[bytes, IndexEntry]) -> Tree:
    """The index read as a tree: every path with its mode and blob id.

    Args:
        entries (dict[bytes, IndexEntry]): the index.
    """
    return {path: (entry.mode, entry.sha) for path, entry in entries.items()}


def decoded(paths: Iterable[bytes]) -> set[str]:
    """Repository-relative paths as text.

    Args:
        paths (Iterable[bytes]): index, conflict or tree keys.
    """
    return {path.decode("utf-8", errors="replace") for path in paths}


def source_tree(repo: BaseRepo, revision: str) -> Tree:
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
    # A bare id names the object itself, so an annotated tag arrives as
    # the tag rather than as what it points at. A tag is no tree-ish,
    # and unwrapping it is what makes ``--source=<tag-id>`` read the
    # same tree ``--source=v1`` reads.
    found = unwrapped(repo, found, revision)
    if isinstance(found, Commit):
        # git's one implicit peel: a commit stands for its tree here.
        return tree_of(repo, found.id)
    if found.type_name.decode() != TREE:
        raise UnreadableTreeError(found.id.decode())
    return flat_tree(repo, found.id)


async def restore(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Put paths back to what a source records.

    Two targets and one source, git's own model. ``--staged`` restores
    the index and ``--worktree`` the working tree; the default is the
    working tree alone. The source is the index for the working tree
    and HEAD for the index unless ``--source`` names a tree, in which
    case a selected path the source does not hold is removed from
    whichever target is being restored, since that is what "make it
    match the source" means for it. Pinned against git 2.50.1.

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
    notes: list[str] = []
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError, escaped(inv.argv),
                       switches(inv))
        if not texts:
            raise NoRestorePathsError()
        flags = parse_flags(fl)
        repo, location = await opened(fl, doors)
        state = await read_index(dispatch, location.gitdir)
        held = index_tree(state.entries)
        if flags.source is not None:
            source: Tree | None = await asyncio.to_thread(
                source_tree, repo, flags.source)
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
        tree = held if source is None else source
        # The conflict stages name paths too. An unmerged path has no
        # stage-0 entry, so neither the index nor HEAD carries it and
        # the pathspec would miss what git matches: to git it is an
        # index entry like any other. Selecting it is what lets a
        # source holding it put it back, stages and all, and what lets
        # the refusal below name it when none does.
        names = decoded(held) | decoded(tree) | decoded(state.conflicts)
        start = start_point(fl)
        selected: set[str] = set()
        for operand in texts:
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
        unmerged = [
            name for name in absent if name.encode() in state.conflicts
        ]
        if unmerged:
            raise UnmergedPathError(unmerged)
        links = links_of(doors)
        mounts = mounts_of(doors)
        # Before the index is written, not at the entry that meets it:
        # ``-SW`` stages first and restores after, so a refusal in the
        # working-tree pass would leave the index moved and the tree
        # exactly as it was, which is the one outcome this verb has no
        # wording for.
        # A gitlink is not written into the working tree at all, so it
        # is neither read as a blob nor allowed to clear what stands at
        # the name; keep_gitlink is the whole of what the entry asks
        # for, and the preflight has nothing to say about it either.
        replacing = sorted(name for name in present
                           if tree[name.encode()][0] != GITLINK)
        # A gitlink's directory is not this verb's to empty either. The
        # entry is a placeholder for a repository mirage cannot read, so
        # git writes the directory and leaves every path under it alone:
        # a child the source drops loses its index entry and keeps its
        # working-tree copy, edits included. Removing it here is the one
        # loss nothing can undo, since the content was never staged.
        # Pinned against git 2.50.1.
        linked = [
            name for name in present if tree[name.encode()][0] == GITLINK
        ]
        dropped = sorted(name for name in absent
                         if not any(under(name, root) for root in linked))
        if flags.worktree:
            await refuse_replaced_mounts(stat_path, location.worktree,
                                         replacing, links, mounts)
        if flags.staged:
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
            await write_index(dispatch, location.gitdir, state)
        if flags.worktree:
            blobs = await asyncio.to_thread(
                contents, repo, [tree[name.encode()][1] for name in replacing])
            # Removals first, because the two sets can name the same
            # place: restoring a directory over a file writes
            # ``slot/child`` where the file ``slot`` still sits, and the
            # other direction writes the file where the directory still
            # sits. Nothing is read back from the working tree, so
            # emptying it first is free.
            for name in dropped:
                path = posixpath.join(location.worktree, name)
                # A component above the entry that is not a directory
                # is not a way through to it: the unlink would resolve
                # past it and delete a file inside whatever it points
                # at, which no branch named. git checks the leading
                # path and removes nothing when it finds one, so
                # neither does this.
                if await blocking_ancestor(stat_path, location.worktree, name,
                                           links):
                    continue
                # What stands at a gitlink is a directory, so taking it
                # away is an rmdir that may legitimately fail: unlink
                # died on it with the index already written, which is
                # the half-restore this verb has no wording for.
                if held.get(name.encode(), (0, b""))[0] == GITLINK:
                    warned = await drop_gitlink(dispatch, stat_path, path,
                                                name, links)
                    if warned is not None:
                        notes.append(warned)
                else:
                    await remove_file(dispatch, path)
                await remove_empty_parents(dispatch, path, location.worktree,
                                           mounts)
            for name in sorted(present):
                mode, sha = tree[name.encode()]
                where = posixpath.join(location.worktree, name)
                if mode == GITLINK:
                    await keep_gitlink(dispatch, stat_path, where, links)
                    continue
                # The write direction takes the same component the
                # other way round: the entry needs a directory where it
                # stands, so git replaces it with one rather than
                # writing through it. A link's target tree is left
                # exactly as it was, and an untracked file standing
                # there is replaced in silence, which is what git's
                # create_directories does to any leading non-directory.
                above = await blocking_ancestor(stat_path, location.worktree,
                                                name, links)
                if above is not None:
                    await remove_file(dispatch, above)
                # A directory can still stand here after the loop
                # above: it removed the tracked children, but an
                # untracked one keeps it alive and the write would
                # fail on it with the index already updated. git
                # replaces the whole directory, untracked children
                # included. A link is left to restore_entry, which
                # retargets it; following one to a directory here
                # would delete a tree no branch named.
                if links is None or links.stat_at(where) is None:
                    info = await stat_path(where)
                    if info is not None and info.type is FileType.DIRECTORY:
                        await remove_tree(dispatch, where, links, mounts)
                await restore_entry(dispatch, where, mode, blobs[sha], links)
    except GitError as exc:
        return fatal(exc)
    told = "".join(notes).encode()
    return None, IOResult(stderr=told) if told else IOResult()
