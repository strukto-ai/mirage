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

from dulwich.diff_tree import tree_changes
from dulwich.object_store import BaseObjectStore
from dulwich.objects import Blob, Commit, ObjectID

EMPTY_TREE = None


def _occurrences(store: BaseObjectStore, sha: ObjectID | None,
                 needle: bytes) -> int:
    """How many times a string appears in one blob.

    Args:
        store (BaseObjectStore): object database holding the blob.
        sha (ObjectID | None): blob id, None when the side does not
            exist.
        needle (bytes): the string being counted.
    """
    if sha is None:
        return 0
    obj = store[sha]
    if not isinstance(obj, Blob):
        return 0
    return obj.data.count(needle)


def touches(store: BaseObjectStore, commit: Commit, needle: bytes) -> bool:
    """Whether a commit changed the number of occurrences of a string.

    This is git's ``-S`` (pickaxe), and it is deliberately not a grep: a
    commit that merely moves a line containing the string does not
    change how many times the string appears, so it is not reported. The
    commit that *introduced* the string is, which is what makes
    ``-S <name> --reverse`` answer "where did this come from".

    Compared against the first parent, or against nothing for a root
    commit, so the objects a root commit adds all count as introduced.

    Args:
        store (BaseObjectStore): object database holding the trees.
        commit (Commit): the commit to test.
        needle (bytes): the string being counted.
    """
    parent_tree = EMPTY_TREE
    if commit.parents:
        parent = store[commit.parents[0]]
        assert isinstance(parent, Commit)
        parent_tree = parent.tree
    for change in tree_changes(store, parent_tree, commit.tree):
        old = change.old.sha if change.old is not None else None
        new = change.new.sha if change.new is not None else None
        if _occurrences(store, old,
                        needle) != _occurrences(store, new, needle):
            return True
    return False
