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

import re
import stat

from dulwich.object_store import iter_tree_contents
from dulwich.objects import Blob, Commit, ObjectID, ShaFile
from dulwich.objects import Tree as GitTree
from dulwich.objectspec import parse_commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import TREE
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.revparse import resolve_object, unwrapped
from mirage.commands.cli.builtin.git.seen import rooted

Tree = dict[bytes, tuple[int, bytes]]
DOT_GIT = re.compile(
    r"(?:\.git|git~1)[ .]*(?::.*)?", re.IGNORECASE | re.DOTALL | re.ASCII
)
GITMODULES_LINK = re.compile(
    r"(?:\.gitmodules|gitmod~[1-4]|~[1-9][0-9]{6}|g~[1-9][0-9]{5}"
    r"|gi~[1-9][0-9]{4}|gi7~[1-9][0-9]{3}|gi7e~[1-9][0-9]{2}"
    r"|gi7eb~[1-9][0-9]|gi7eba~[1-9])[ .]*(?::.*)?",
    re.IGNORECASE | re.DOTALL | re.ASCII,
)
GITMODULES_DIR = re.compile(
    r"\.gitmodules(?::.*)?", re.IGNORECASE | re.DOTALL | re.ASCII
)


def tree_entries(repo: BaseRepo, tree: bytes | None) -> Tree:
    """Every blob a tree holds, keyed by repository-relative path, with
    its mode and blob id.

    Synchronous, and called on a worker thread: reading a tree pulls
    objects through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        tree (bytes | None): the tree id, None for the empty tree a
            root commit diffs against.
    """
    if tree is None:
        return {}
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(repo.object_store, ObjectID(tree))
    }


def ntfs_pieces(part: str) -> list[str]:
    """A path part as NTFS reads it: split at every backslash but one
    that starts the part, which git keeps as part of the name.

    Args:
        part (str): one ``/``-separated part of a tree path.
    """
    head, *rest = part[1:].split("\\")
    return [part[:1] + head, *rest]


def valid_path(path: str, mode: int) -> bool:
    """Whether a tree path passes git's checkout rule, pinned against
    git 2.47.3 with its defaults (every row is in test_tree.py).

    Refused: a part that is empty, ``.`` or ``..``; a part, or an NTFS
    piece of one, that NTFS reads as ``.git`` (``.git`` or its short name
    ``git~1``, then dots or spaces, then the end or a ``:`` stream); and
    for a symlink, a last piece NTFS reads as ``.gitmodules`` (the name,
    its short names ``gitmod~1``-``~4``, or the 8-character hashed short
    name built on ``gi7eba``), or a directory part that is
    ``.gitmodules``, with or without a ``:`` stream. Case is
    ASCII-folded, as git folds it. macOS's HFS spellings of ``.git``
    are not covered. An empty-named tree entry below the root reaches
    here as an empty part, except a directory on this host, which
    dulwich joins away.

    Args:
        path (str): the repository-relative path a tree records.
        mode (int): the entry's mode.
    """
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    if any(
        DOT_GIT.fullmatch(piece)
        for part in parts
        for piece in ntfs_pieces(part)
    ):
        return False
    if not stat.S_ISLNK(mode):
        return True
    return not GITMODULES_LINK.fullmatch(
        ntfs_pieces(parts[-1])[-1]
    ) and not any(GITMODULES_DIR.fullmatch(part) for part in parts[:-1])


def commit_entries(repo: BaseRepo, commit_id: ObjectID) -> Tree:
    """Every path a commit's tree holds, with its mode and blob id.

    Args:
        repo (BaseRepo): the opened repository.
        commit_id (ObjectID): the commit to read.
    """
    return tree_entries(repo, parse_commit(repo, commit_id).tree)


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


def resolve_tree(
    repo: BaseRepo, name: str, obj: ShaFile | None = None
) -> ObjectID:
    """Resolve a tree-ish through tags and commits.

    Args:
        repo (BaseRepo): opened object database.
        name (str): revision as typed.
        obj (ShaFile | None): already resolved object, when the caller has it.
    """
    obj = unwrapped(
        repo, resolve_object(repo, name) if obj is None else obj, name
    )
    if isinstance(obj, Commit):
        rooted(repo, obj.tree, name)
        return ObjectID(obj.tree)
    if isinstance(obj, GitTree):
        return ObjectID(obj.id)
    raise GitError("not a tree object")


def listed_tree(
    repo: BaseRepo,
    tree: ObjectID,
    patterns: tuple[str, ...],
    recursive: bool,
    trees: bool,
    directories: bool,
    prefix: str = "",
) -> list[tuple[str, str, str]]:
    """List literal tree prefixes without reading any blob content.

    Git ls-tree operands are literal prefixes, unlike diff pathspecs.
    A trailing slash descends into a named tree even without -r.

    Args:
        repo (BaseRepo): opened object database.
        tree (ObjectID): tree to visit.
        patterns (tuple[str, ...]): repository-relative literal prefixes.
        recursive (bool): descend into every selected directory.
        trees (bool): also emit trees being traversed.
        directories (bool): suppress leaves.
        prefix (str): repository-relative parent.
    """
    obj = repo.object_store[tree]
    assert isinstance(obj, GitTree)
    out: list[tuple[str, str, str]] = []
    for entry in obj.iteritems():
        name = entry.path.decode("utf-8", "surrogateescape")
        path = f"{prefix}/{name}" if prefix else name
        selected = not patterns or any(
            pattern == ""
            or path == pattern
            or path.startswith(pattern.rstrip("/") + "/")
            for pattern in patterns
        )
        row = (path, f"{entry.mode:06o}", entry.sha.decode())
        if entry.mode != TREE:
            if selected and not directories:
                out.append(row)
            continue
        descend = (recursive and selected) or any(
            pattern.startswith(path + "/") for pattern in patterns
        )
        show_tree = trees or directories and (selected or recursive)
        if (selected and not descend) or (descend and show_tree):
            out.append(row)
        if descend:
            out.extend(
                listed_tree(
                    repo,
                    entry.sha,
                    patterns,
                    recursive,
                    trees,
                    directories,
                    path,
                )
            )
    return out
