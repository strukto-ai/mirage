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
from dulwich.objects import Blob, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.repo import BaseRepo

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
