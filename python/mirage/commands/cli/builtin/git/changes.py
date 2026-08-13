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
from stat import S_IFMT, S_IFREG, S_IXUSR

from dulwich.diff_tree import _similarity_score
from dulwich.index import ConflictedIndexEntry, IndexEntry
from dulwich.object_store import BaseObjectStore, iter_tree_contents
from dulwich.objects import Blob, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.index import read_index
from mirage.commands.cli.builtin.git.io import read_file
from mirage.commands.cli.builtin.git.types import (IndexState, RepoLocation,
                                                   StatusEntry, WorkTree)
from mirage.commands.cli.builtin.git.worktree import scan
from mirage.ops.types import StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat
from mirage.utils.errors import MISS_ERRORS

HEAD_REF = Ref(b"HEAD")
UNCHANGED = " "
MODIFIED = "M"
ADDED = "A"
DELETED = "D"
RENAMED = "R"
UNMERGED = "U"
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


def _exact_renames(adds: list[str], deletes: list[str],
                   shas: dict[str, bytes]) -> list[tuple[str, str]]:
    """Pair an add with a delete holding byte-identical content.

    Costs a dictionary rather than a read, so it runs first and takes
    every pair it can before anything is fetched.

    Args:
        adds (list[str]): paths the index has and HEAD does not.
        deletes (list[str]): paths HEAD has and the index does not.
        shas (dict[str, bytes]): blob id of each, on whichever side it
            exists.
    """
    sources: dict[bytes, str] = {}
    for path in deletes:
        sources.setdefault(shas[path], path)
    taken: set[str] = set()
    pairs = []
    for path in adds:
        origin = sources.get(shas[path])
        if origin is not None and origin not in taken:
            taken.add(origin)
            pairs.append((path, origin))
    return pairs


def _content_renames(store: BaseObjectStore, adds: list[str],
                     deletes: list[str],
                     shas: dict[str, bytes]) -> list[tuple[str, str]]:
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
    if not adds or not deletes or len(adds) * len(
            deletes) > MAX_RENAME_FILES**2:
        return []
    cache: dict[ObjectID, dict[int, int]] = {}
    candidates = []
    for old in deletes:
        source = store[ObjectID(shas[old])]
        for new in adds:
            score = _similarity_score(source, store[ObjectID(shas[new])],
                                      cache)
            if score >= RENAME_THRESHOLD:
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


def _pair_renames(store: BaseObjectStore, staged: dict[str, str],
                  shas: dict[str, bytes],
                  regular: set[str]) -> dict[str, tuple[str, str | None]]:
    """Fold an add and a delete of the same file into one rename.

    Two passes, git's own order: identical content first, then what is
    merely similar enough. Only regular files are candidates, because a
    symlink and a file that happen to share bytes are not a rename of
    each other.

    Args:
        store (BaseObjectStore): the object database, read for blobs.
        staged (dict[str, str]): path to its one-letter staged status.
        shas (dict[str, bytes]): blob id on whichever side exists, for
            the added and deleted paths only.
        regular (set[str]): of those, the ones that are regular files.
    """
    adds = sorted(path for path, letter in staged.items()
                  if letter == ADDED and path in regular)
    deletes = sorted(path for path, letter in staged.items()
                     if letter == DELETED and path in regular)
    pairs = _exact_renames(adds, deletes, shas)
    matched_new = {new for new, _old in pairs}
    matched_old = {old for _new, old in pairs}
    pairs.extend(
        _content_renames(store, [p for p in adds if p not in matched_new],
                         [p for p in deletes if p not in matched_old], shas))
    paired = {new: (RENAMED, old) for new, old in pairs}
    consumed = {old for _new, old in pairs}
    return {
        path: paired.get(path, (letter, None))
        for path, letter in staged.items() if path not in consumed
    }


def stage_changes(store: BaseObjectStore,
                  head: dict[bytes, tuple[int, bytes]] | None,
                  entries: dict[bytes, IndexEntry],
                  conflicts: set[bytes]) -> dict[str, tuple[str, str | None]]:
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
    regular: set[str] = set()
    for path, entry in entries.items():
        name = path.decode("utf-8", errors="replace")
        recorded = tree.get(path)
        if recorded is None:
            staged[name] = ADDED
            shas[name] = entry.sha
            if S_IFMT(entry.mode) == S_IFREG:
                regular.add(name)
        elif recorded[1] != entry.sha or recorded[0] != entry.mode:
            staged[name] = MODIFIED
    for path, (mode, sha) in tree.items():
        if path not in entries and path not in conflicts:
            name = path.decode("utf-8", errors="replace")
            staged[name] = DELETED
            shas[name] = sha
            if S_IFMT(mode) == S_IFREG:
                regular.add(name)
    return _pair_renames(store, staged, shas, regular)


def staged_state(
        repo: BaseRepo, entries: dict[bytes, IndexEntry], conflicts: set[bytes]
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
    """
    head = head_entries(repo)
    changed = stage_changes(repo.object_store, head, entries, conflicts)
    return changed, head is None


def conflict_codes(
        conflicts: dict[bytes, ConflictedIndexEntry]) -> dict[str, str]:
    """The two-letter code for each unmerged path.

    Args:
        conflicts (dict[bytes, ConflictedIndexEntry]): unmerged entries.
    """
    codes: dict[str, str] = {}
    for path, entry in conflicts.items():
        name = path.decode("utf-8", errors="replace")
        stages = (entry.ancestor is not None, entry.this
                  is not None, entry.other is not None)
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


async def _differs(dispatch: DispatchFn, worktree: str, path: str,
                   entry: IndexEntry, info: FileStat) -> bool:
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
        worktree (str): absolute virtual path of the working tree root.
        path (str): repository-relative path.
        entry (IndexEntry): what the index staged for it.
        info (FileStat): what the mount says about it now.
    """
    if _mode_differs(entry, info):
        return True
    if info.size is not None and entry.size and info.size != entry.size:
        return True
    try:
        data = await read_file(dispatch, posixpath.join(worktree, path))
    except MISS_ERRORS:
        return True
    return Blob.from_string(data).id != entry.sha


async def work_changes(dispatch: DispatchFn, worktree: str,
                       entries: dict[bytes, IndexEntry],
                       found: WorkTree) -> dict[str, str]:
    """Compare the index with the working tree: what is not staged yet.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        worktree (str): absolute virtual path of the working tree root.
        entries (dict[bytes, IndexEntry]): the index.
        found (WorkTree): what the walk of the working tree found.
    """
    changes: dict[str, str] = {}
    for path, entry in entries.items():
        name = path.decode("utf-8", errors="replace")
        if name not in found.files:
            changes[name] = DELETED
        elif await _differs(dispatch, worktree, name, entry,
                            found.files[name]):
            changes[name] = MODIFIED
    return changes


def merge(staged: dict[str, tuple[str, str | None]], unstaged: dict[str, str],
          conflicts: dict[str,
                          str], untracked: list[str]) -> list[StatusEntry]:
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
            StatusEntry(path, letter, unstaged.get(path, UNCHANGED), origin))
    for path in sorted(untracked):
        rows.append(StatusEntry(path, UNTRACKED, UNTRACKED))
    return rows


async def collect(dispatch: DispatchFn, stat_path: StatPath, repo: BaseRepo,
                  location: RepoLocation,
                  mode: str) -> tuple[list[StatusEntry], IndexState, bool]:
    """Everything ``status`` reports, in one pass over the three sources.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        mode (str): which untracked files to report.
    """
    state = await read_index(dispatch, location.gitdir)
    staged, no_commits = await asyncio.to_thread(staged_state, repo,
                                                 state.entries,
                                                 set(state.conflicts))
    tracked = {
        path.decode("utf-8", errors="replace")
        for path in (set(state.entries) | set(state.conflicts))
    }
    found = await scan(dispatch, stat_path, location, tracked, mode)
    unstaged = await work_changes(dispatch, location.worktree, state.entries,
                                  found)
    rows = merge(staged, unstaged, conflict_codes(state.conflicts),
                 found.untracked)
    return rows, state, no_commits
