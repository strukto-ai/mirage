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

from dulwich.object_store import BaseObjectStore, iter_tree_contents
from dulwich.objects import Blob, Commit, ObjectID
from dulwich.objects import Tree as GitTree
from dulwich.objectspec import parse_commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.revparse import resolve_object, unwrapped

Tree = dict[bytes, tuple[int, bytes]]


def tree_entries(
    store: BaseObjectStore, tree: bytes | None
) -> dict[bytes, tuple[int, bytes]]:
    """Every blob a tree holds, keyed by repository-relative path.

    Args:
        store (BaseObjectStore): the object database.
        tree (bytes | None): the tree id, None for the empty tree a
            root commit diffs against.
    """
    if tree is None:
        return {}
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(store, ObjectID(tree))
    }


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


def resolve_tree(repo: BaseRepo, name: str) -> ObjectID:
    """Resolve a tree-ish through tags and commits.

    Args:
        repo (BaseRepo): opened object database.
        name (str): revision as typed.
    """
    obj = unwrapped(repo, resolve_object(repo, name), name)
    if isinstance(obj, Commit):
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
        directory = entry.mode == 0o40000
        descend = directory and (
            (recursive and selected)
            or any(pattern.startswith(path + "/") for pattern in patterns)
        )
        if (
            selected
            or directory
            and descend
            and (trees or directories and recursive)
        ) and (
            directory
            and (not descend or trees or directories)
            or not directory
            and not directories
        ):
            out.append((path, f"{entry.mode:06o}", entry.sha.decode()))
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
