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
from stat import S_IFMT, S_IFREG, S_IXUSR

from dulwich.diff_tree import _similarity_score
from dulwich.index import ConflictedIndexEntry, IndexEntry
from dulwich.object_store import BaseObjectStore, iter_tree_contents
from dulwich.objects import Blob, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.add import entry_mode
from mirage.commands.cli.builtin.git.constants import (
    GITLINK,
    HEAD_REF,
    SYMLINK,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import entry_bytes
from mirage.commands.cli.builtin.git.objects import VfsObjectStore
from mirage.commands.cli.builtin.git.pathspec import visible_entries
from mirage.commands.cli.builtin.git.types import (
    IndexState,
    RepoLocation,
    StatusEntry,
    WorkTree,
)
from mirage.commands.cli.builtin.git.worktree import UNTRACKED_NO, scan
from mirage.ops.types import LinkView, StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import MISS_ERRORS

UNCHANGED = " "
MODIFIED = "M"
ADDED = "A"
DELETED = "D"
TYPE_CHANGED = "T"
RENAMED = "R"
UNTRACKED = "?"
# git's own two rename knobs: a pair counts as a rename at 60% shared
# content, and the search is abandoned entirely once the add-by-delete
# matrix would exceed 200 by 200. Matching both is what makes mirage
# give up exactly where git gives up rather than answer differently.
RENAME_THRESHOLD = 60
MAX_RENAME_FILES = 200

# git spells an unmerged path by which of the three index stages it kept,
# keyed here as (ancestor, ours, theirs). The pair is the porcelain XY,
# and the long format's label follows from it.
CONFLICT_CODES = {
    (True, True, True): "UU",
    (True, True, False): "UD",
    (True, False, True): "DU",
    (True, False, False): "DD",
    (False, True, True): "AA",
    (False, True, False): "AU",
    (False, False, True): "UA",
}


def head_entries(repo: BaseRepo) -> dict[bytes, tuple[int, bytes]] | None:
    """Every path HEAD's tree holds, with its mode and blob id.

    None rather than an empty mapping when HEAD resolves to nothing: a
    repository before its first commit is a different thing from one
    whose commit is empty, and git says so ("No commits yet").

    Resolved through dulwich's own committish parser so a HEAD detached
    onto a tag peels to the commit it names, rather than being read as a
    tree it does not have.

    Synchronous, and called on a worker thread: reading a tree pulls
    objects, and this store fetches them through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
    """
    try:
        commit = parse_commit(repo, HEAD_REF)
    except KeyError:
        return None
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(repo.object_store, commit.tree)
    }


def _exact_renames(
    adds: list[str],
    deletes: list[str],
    shas: dict[str, bytes],
    kinds: dict[str, int],
) -> list[tuple[str, str]]:
    """Pair an add with a delete holding byte-identical content.

    Costs a dictionary rather than a read, so it runs first and takes
    every pair it can before anything is fetched. Keyed by kind as well
    as content, because a symlink and a regular file that happen to
    share bytes are not a rename of each other, while a moved symlink
    is exactly one.

    Args:
        adds (list[str]): paths the index has and HEAD does not.
        deletes (list[str]): paths HEAD has and the index does not.
        shas (dict[str, bytes]): blob id of each, on whichever side it
            exists.
        kinds (dict[str, int]): the file-type bits of each.
    """
    sources: dict[tuple[int, bytes], str] = {}
    for path in deletes:
        sources.setdefault((kinds[path], shas[path]), path)
    taken: set[str] = set()
    pairs = []
    for path in adds:
        origin = sources.get((kinds[path], shas[path]))
        if origin is not None and origin not in taken:
            taken.add(origin)
            pairs.append((path, origin))
    return pairs


def _content_renames(
    store: BaseObjectStore,
    adds: list[str],
    deletes: list[str],
    shas: dict[str, bytes],
    threshold: int = RENAME_THRESHOLD,
) -> list[tuple[str, str]]:
    """Pair the rest by how much content they still have in common.

    This is what makes a move that also edited the file read as one
    rename instead of an add beside a delete. It costs a read of both
    sides of every candidate pair, which is why git bounds the matrix
    and stops trying rather than slow down on a large rewrite; the same
    bound is kept here so the answer agrees with git's on the trees
    where git gives up.

    Args:
        store (BaseObjectStore): the object database, read for blobs.
        adds (list[str]): unpaired paths the index has and HEAD does not.
        deletes (list[str]): unpaired paths HEAD has and the index does
            not.
        shas (dict[str, bytes]): blob id of each.
    """
    if (
        not adds
        or not deletes
        or len(adds) * len(deletes) > MAX_RENAME_FILES**2
    ):
        return []
    cache: dict[ObjectID, dict[int, int]] = {}
    candidates = []
    for old in deletes:
        source = store[ObjectID(shas[old])]
        for new in adds:
            score = _similarity_score(
                source, store[ObjectID(shas[new])], cache
            )
            if score >= threshold:
                # Negative score so the strongest pair sorts first while
                # paths still tie-break in ascending order, which is what
                # makes two equally similar candidates resolve the same
                # way on every run.
                candidates.append((-score, new, old))
    candidates.sort()
    taken_new: set[str] = set()
    taken_old: set[str] = set()
    pairs = []
    for _score, new, old in candidates:
        if new in taken_new or old in taken_old:
            continue
        taken_new.add(new)
        taken_old.add(old)
        pairs.append((new, old))
    return pairs


def pair_renames(
    store: BaseObjectStore,
    staged: dict[str, str],
    shas: dict[str, bytes],
    kinds: dict[str, int],
    threshold: int = RENAME_THRESHOLD,
) -> dict[str, tuple[str, str | None]]:
    """Fold an add and a delete of the same file into one rename.

    Two passes, git's own order: identical content first, then what is
    merely similar enough. Both pair within one kind, and only the
    second is limited to regular files: a moved symlink is a rename git
    reports as one, but scoring a link against a file would pair two
    unrelated things by the bytes of a path.

    Args:
        store (BaseObjectStore): the object database, read for blobs.
        staged (dict[str, str]): path to its one-letter staged status.
        shas (dict[str, bytes]): blob id on whichever side exists, for
            the added and deleted paths only.
        kinds (dict[str, int]): the file-type bits of each.
    """
    adds = sorted(
        path
        for path, letter in staged.items()
        if letter == ADDED and path in kinds
    )
    deletes = sorted(
        path
        for path, letter in staged.items()
        if letter == DELETED and path in kinds
    )
    pairs = _exact_renames(adds, deletes, shas, kinds)
    matched_new = {new for new, _old in pairs}
    matched_old = {old for _new, old in pairs}
    scored = [
        [p for p in side if kinds[p] == S_IFREG]
        for side in (
            [p for p in adds if p not in matched_new],
            [p for p in deletes if p not in matched_old],
        )
    ]
    pairs.extend(
        _content_renames(store, scored[0], scored[1], shas, threshold)
    )
    paired = {new: (RENAMED, old) for new, old in pairs}
    consumed = {old for _new, old in pairs}
    return {
        path: paired.get(path, (letter, None))
        for path, letter in staged.items()
        if path not in consumed
    }


def stage_changes(
    store: BaseObjectStore,
    head: dict[bytes, tuple[int, bytes]] | None,
    entries: dict[bytes, IndexEntry],
    conflicts: set[bytes],
) -> dict[str, tuple[str, str | None]]:
    """Compare HEAD's tree with the index: what a commit would record.

    Conflicted paths are excluded rather than compared. An unmerged path
    holds no ordinary index entry, so comparing it against HEAD's tree
    would find the path on one side only and call it deleted, which is
    the opposite of what is happening to it.

    Args:
        store (BaseObjectStore): the object database, read for blobs when
            a rename has to be scored.
        head (dict | None): HEAD's tree, or None before the first commit.
        entries (dict[bytes, IndexEntry]): the index.
        conflicts (set[bytes]): paths left unmerged.
    """
    tree = head or {}
    staged: dict[str, str] = {}
    shas: dict[str, bytes] = {}
    kinds: dict[str, int] = {}
    for path, entry in entries.items():
        name = path.decode("utf-8", errors="replace")
        recorded = tree.get(path)
        if recorded is None:
            staged[name] = ADDED
            shas[name] = entry.sha
            kinds[name] = S_IFMT(entry.mode)
        elif recorded[1] != entry.sha or recorded[0] != entry.mode:
            staged[name] = MODIFIED
    for path, (mode, sha) in tree.items():
        if path not in entries and path not in conflicts:
            name = path.decode("utf-8", errors="replace")
            staged[name] = DELETED
            shas[name] = sha
            kinds[name] = S_IFMT(mode)
    return pair_renames(store, staged, shas, kinds)


def staged_state(
    repo: BaseRepo,
    entries: dict[bytes, IndexEntry],
    conflicts: set[bytes],
    location: RepoLocation,
) -> tuple[dict[str, tuple[str, str | None]], bool]:
    """Everything HEAD-against-index, computed off the event loop.

    One function rather than two calls because both halves read objects
    through a store that fetches over the dispatcher, so both have to sit
    on the worker thread; splitting them would put a blocking fetch back
    on the loop that has to serve it.

    Args:
        repo (BaseRepo): the opened repository.
        entries (dict[bytes, IndexEntry]): the index.
        conflicts (set[bytes]): paths left unmerged.
        location (RepoLocation): repository and session visibility.
    """
    head = head_entries(repo)
    if head is not None:
        head = visible_entries(location, head)
    changed = stage_changes(repo.object_store, head, entries, conflicts)
    return changed, head is None


def conflict_codes(
    conflicts: dict[bytes, ConflictedIndexEntry],
) -> dict[str, str]:
    """The two-letter code for each unmerged path.

    Args:
        conflicts (dict[bytes, ConflictedIndexEntry]): unmerged entries.
    """
    codes: dict[str, str] = {}
    for path, entry in conflicts.items():
        name = path.decode("utf-8", errors="replace")
        stages = (
            entry.ancestor is not None,
            entry.this is not None,
            entry.other is not None,
        )
        codes[name] = CONFLICT_CODES.get(stages, "UU")
    return codes


def _mode_differs(entry: IndexEntry, info: FileStat) -> bool:
    """Whether the executable bit moved since the path was staged.

    git tracks exactly one permission bit and only the owner's copy of
    it: ``chmod 744`` is a modification and ``chmod 645`` is not, pinned
    against git 2.47. Nothing is claimed when the mount reports no mode
    at all, which is most of them; a backend that has no permissions to
    report would otherwise make every executable file look changed.

    Args:
        entry (IndexEntry): what the index staged for the path.
        info (FileStat): what the mount says about it now.
    """
    if info.mode is None or S_IFMT(entry.mode) != S_IFREG:
        return False
    return bool(entry.mode & S_IXUSR) != bool(info.mode & S_IXUSR)


async def _differs(
    dispatch: DispatchFn,
    worktree: PathSpec,
    path: str,
    entry: IndexEntry,
    info: FileStat,
) -> bool:
    """Whether a working-tree file differs from what the index staged.

    A size the mount already reported settles most of it for free, since
    an edit that keeps the byte count is the exception. When the sizes
    agree the file is read and hashed, because that is the only thing
    that actually answers the question. git normally skips even that by
    trusting the stat data it cached (device, inode, mtime to the
    nanosecond); a mount serves none of those meaningfully, so the cheap
    answer is not available here and a wrong one is worse than a slow
    one.

    A recorded size of zero is read as "not stated" rather than "empty",
    because that is what mirage writes for an entry it restored from a
    tree without reading the blob. Trusting it would report every
    tracked file as modified the moment anything was unstaged, which is
    exactly what it did. Nothing is lost: a genuinely empty file falls
    through to the hash and compares equal there.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        worktree (PathSpec): absolute virtual path of the working tree root.
        path (str): repository-relative path.
        entry (IndexEntry): what the index staged for it.
        info (FileStat): what the mount says about it now.
    """
    if _mode_differs(entry, info):
        return True
    if info.size is not None and entry.size and info.size != entry.size:
        return True
    try:
        data = await entry_bytes(dispatch, worktree.join(path), info)
    except MISS_ERRORS:
        return True
    return Blob.from_string(data).id != entry.sha


async def work_changes(
    dispatch: DispatchFn,
    worktree: PathSpec,
    entries: dict[bytes, IndexEntry],
    found: WorkTree,
) -> dict[str, str]:
    """Compare the index with the working tree: what is not staged yet.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        worktree (PathSpec): absolute virtual path of the working tree root.
        entries (dict[bytes, IndexEntry]): the index.
        found (WorkTree): what the walk of the working tree found.
    """
    changes: dict[str, str] = {}
    for path, entry in entries.items():
        name = path.decode("utf-8", errors="replace")
        # A 160000 entry records another repository's HEAD, and what
        # stands at the name is a directory, so the walk never finds a
        # file there and every submodule read as deleted. git compares
        # the submodule's own HEAD, which is unreadable from here, and
        # says nothing at all when there is none; saying nothing is both
        # the closest this can get and what keeps a branch switch away
        # from a submodule from being refused over a file that was never
        # missing.
        if entry.mode == GITLINK:
            continue
        if name not in found.files:
            changes[name] = DELETED
        elif (found.files[name].type is FileType.SYMLINK) != (
            S_IFMT(entry.mode) == SYMLINK
        ):
            # A symlink and a file holding its target text hash alike.
            changes[name] = TYPE_CHANGED
        elif await _differs(
            dispatch, worktree, name, entry, found.files[name]
        ):
            changes[name] = MODIFIED
    return changes


def staged_entries(state: IndexState) -> dict[bytes, tuple[int, bytes]]:
    """The index as entries, path to (mode, id), conflict stages left out.

    Args:
        state (IndexState): the index as read.
    """
    return {
        path: (entry.mode, entry.sha) for path, entry in state.entries.items()
    }


async def work_entries(
    dispatch: DispatchFn,
    stat_path: StatPath,
    repo: BaseRepo,
    location: RepoLocation,
    state: IndexState,
    links: LinkView | None = None,
) -> dict[bytes, tuple[int, bytes]]:
    """The working tree as entries, for the side ``git diff`` compares.

    The index stands for every file the walk found unchanged; a modified
    file is hashed and its blob held in the store for this invocation
    only, as git writes nothing on a diff. Untracked files are not part
    of it. A path the index holds only as conflict stages is the file
    standing there, if any: what a revision is compared with, while the
    index side leaves it out (git shows a combined diff there, which is
    not offered).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        repo (BaseRepo): the opened repository, whose store holds the
            hashed blobs.
        location (RepoLocation): the discovered repository.
        state (IndexState): the index as read.
        links (LinkView | None): the name plane's link facts.
    """
    tracked = {
        path.decode("utf-8", errors="replace")
        for path in (set(state.entries) | set(state.conflicts))
    }
    found = await scan(
        dispatch, stat_path, location, tracked, UNTRACKED_NO, links
    )
    changes = await work_changes(
        dispatch, location.worktree, state.entries, found
    )
    entries = staged_entries(state)
    store = repo.object_store
    assert isinstance(store, VfsObjectStore)
    for path in [*state.entries, *state.conflicts]:
        name = path.decode("utf-8", errors="replace")
        info = found.files.get(name)
        if path in state.conflicts:
            code = None if info is None else MODIFIED
        else:
            code = changes.get(name)
        if code is None:
            continue
        if info is None:
            del entries[path]
            continue
        blob = Blob.from_string(
            await entry_bytes(dispatch, location.worktree.join(name), info)
        )
        store.hold(blob)
        entries[path] = (entry_mode(info), blob.id)
    return entries


def merge(
    staged: dict[str, tuple[str, str | None]],
    unstaged: dict[str, str],
    conflicts: dict[str, str],
    untracked: list[str],
) -> list[StatusEntry]:
    """Assemble one row per path from the three comparisons.

    A path can appear in both the staged and unstaged mappings, and that
    is the point of carrying two columns: it is one row reading ``MM``,
    not two rows.

    Sorting is per group, not overall, which is git's own order:
    everything tracked sorts together (an unmerged path among the rest,
    verified against git 2.47), and untracked paths follow as their own
    sorted block however they collate against the tracked ones.

    Args:
        staged (dict): HEAD against the index.
        unstaged (dict[str, str]): the index against the working tree.
        conflicts (dict[str, str]): unmerged paths and their codes.
        untracked (list[str]): paths the working tree holds and the
            index does not.
    """
    rows: list[StatusEntry] = []
    for path in sorted(set(staged) | set(unstaged) | set(conflicts)):
        code = conflicts.get(path)
        if code is not None:
            rows.append(StatusEntry(path, code[0], code[1]))
            continue
        letter, origin = staged.get(path, (UNCHANGED, None))
        rows.append(
            StatusEntry(path, letter, unstaged.get(path, UNCHANGED), origin)
        )
    for path in sorted(untracked):
        rows.append(StatusEntry(path, UNTRACKED, UNTRACKED))
    return rows


async def collect(
    dispatch: DispatchFn,
    stat_path: StatPath,
    repo: BaseRepo,
    location: RepoLocation,
    mode: str,
    links: LinkView | None = None,
    show_ignored: bool = False,
) -> tuple[list[StatusEntry], IndexState, bool]:
    """Everything ``status`` reports, in one pass over the three sources.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        mode (str): which untracked files to report.
    """
    state = await read_index(dispatch, location.gitdir)
    entries = visible_entries(location, state.entries)
    conflicts = visible_entries(location, state.conflicts)
    staged, no_commits = await asyncio.to_thread(
        staged_state, repo, entries, set(conflicts), location
    )
    tracked = {
        path.decode("utf-8", errors="replace")
        for path in (set(entries) | set(conflicts))
    }
    found = await scan(
        dispatch, stat_path, location, tracked, mode, links, show_ignored
    )
    unstaged = await work_changes(dispatch, location.worktree, entries, found)
    rows = merge(staged, unstaged, conflict_codes(conflicts), found.untracked)
    rows.extend(StatusEntry(path, "!", "!") for path in sorted(found.ignored))
    return rows, state, no_commits
