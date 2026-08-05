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

from dataclasses import dataclass, field

from dulwich.index import ConflictedIndexEntry, IndexEntry

from mirage.types import FileStat


@dataclass(frozen=True, slots=True)
class RepoLocation:
    """A resolved repository: where the objects live, and over what.

    ``gitdir`` and ``worktree`` are separate for the same reason they are
    in git: the two need not be nested, and a bare repository has no
    worktree at all.

    ``commondir`` is the third: a linked worktree (``git worktree add``)
    gets its own gitdir holding HEAD and the index, while the object
    database, packed-refs and branches stay in the repository it was cut
    from. The two are the same directory for an ordinary checkout, which
    is why one field carried both until worktrees turned up.

    Args:
        gitdir (str): absolute virtual path of this checkout's git
            directory, which holds HEAD and the index.
        commondir (str): absolute virtual path of the shared git
            directory, which holds objects and branches. Equal to
            ``gitdir`` unless this is a linked worktree.
        worktree (str): absolute virtual path of the working tree root.
        mount_root (str): the mount prefix both live under, which
            bounded the discovery walk.
    """
    gitdir: str
    commondir: str
    worktree: str
    mount_root: str


@dataclass(frozen=True, slots=True)
class HeadRef:
    """What HEAD points at: a branch, some other ref, or a raw commit.

    Args:
        branch (str | None): short branch name when HEAD is a symbolic
            ref under ``refs/heads``, None when detached.
        ref (str | None): the full ref name HEAD names, None when
            detached.
        commit (str | None): the object id HEAD holds directly, set only
            on a detached HEAD.
    """
    branch: str | None
    ref: str | None
    commit: str | None


@dataclass(frozen=True, slots=True)
class AncestryStep:
    """One ``~`` or ``^`` suffix of a revision.

    Args:
        first_parent (bool): True for ``~n`` (walk n generations along
            first parents), False for ``^n`` (take the n-th parent).
        count (int): the number after the suffix, 1 when it was bare.
    """
    first_parent: bool
    count: int


@dataclass(frozen=True, slots=True)
class IndexState:
    """What ``.git/index`` says, split by whether a path is in conflict.

    Conflicted paths are carried apart rather than dropped, because a
    dropped one reads as unmodified: the file would compare equal to
    nothing and vanish from the report while git is refusing to commit
    because of it.

    Args:
        entries (dict[bytes, IndexEntry]): staged content, keyed by
            repository-relative path.
        conflicts (dict[bytes, ConflictedIndexEntry]): paths left
            unmerged, each holding whichever of the three stages exist.
        merging (bool): whether ``MERGE_HEAD`` is present, which is what
            distinguishes a merge in progress from its leftovers.
    """
    entries: dict[bytes, IndexEntry]
    conflicts: dict[bytes, ConflictedIndexEntry]
    merging: bool


@dataclass(frozen=True, slots=True)
class StatusEntry:
    """One path's status, in the two columns git reports it in.

    The pair is git's own model, not a convenience: the left column is
    HEAD against the index and the right is the index against the
    working tree, so a file edited, staged, then edited again is ``MM``
    and appears in both sections of the long format. Collapsing the two
    into one verdict is what makes a status report unable to say that.

    Args:
        path (str): repository-relative path.
        index_status (str): the left column, one character.
        tree_status (str): the right column, one character.
        original (str | None): the path renamed from, set only for
            ``R``.
    """
    path: str
    index_status: str
    tree_status: str
    original: str | None = None


@dataclass(frozen=True, slots=True)
class WorkTree:
    """What one walk of the working tree found.

    Args:
        files (dict[str, FileStat]): every non-ignored file that is not
            under an untracked collapsed directory, mapped to what the
            mount said about it. The whole stat is kept rather than the
            size alone because the comparison reads the mode too, and
            the walk has already paid for it.
        untracked (list[str]): paths to report as untracked, already
            collapsed to ``dir/`` where git would collapse them.
    """
    files: dict[str, FileStat] = field(default_factory=dict)
    untracked: list[str] = field(default_factory=list)
