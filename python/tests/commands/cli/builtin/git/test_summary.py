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

import pytest
from dulwich.object_store import MemoryObjectStore
from dulwich.objects import Blob

from mirage.commands.cli.builtin.git.summary import (count_changes, mode_lines,
                                                     stat_line)

MODE = 0o100644
EXECUTABLE = 0o100755


def store_with(*contents: bytes) -> tuple[MemoryObjectStore, list[bytes]]:
    """A store holding each blob, and their ids in the same order.

    Args:
        contents (bytes): blob contents to store.
    """
    store = MemoryObjectStore()
    ids = []
    for content in contents:
        blob = Blob.from_string(content)
        store.add_object(blob)
        ids.append(blob.id)
    return store, ids


# Each row is (files, insertions, deletions, the line git prints).
# Pinned against git 2.47, including the empty-file commit that proves
# both zero clauses survive when neither has anything to say.
LINES = [
    (1, 2, 0, " 1 file changed, 2 insertions(+)"),
    (1, 0, 1, " 1 file changed, 1 deletion(-)"),
    (2, 3, 0, " 2 files changed, 3 insertions(+)"),
    (1, 1, 1, " 1 file changed, 1 insertion(+), 1 deletion(-)"),
    (1, 0, 0, " 1 file changed, 0 insertions(+), 0 deletions(-)"),
]


@pytest.mark.parametrize("files,plus,minus,expected", LINES)
def test_the_stat_line_matches_git(files, plus, minus, expected):
    assert stat_line(files, plus, minus) == expected


def test_a_new_file_counts_every_line_as_an_insertion():
    store, (sha, ) = store_with(b"one\ntwo\n")
    assert count_changes(store, {}, {b"a.txt": (MODE, sha)}) == (2, 0)


def test_a_removed_file_counts_every_line_as_a_deletion():
    store, (sha, ) = store_with(b"one\ntwo\n")
    assert count_changes(store, {b"a.txt": (MODE, sha)}, {}) == (0, 2)


def test_an_appended_line_is_one_insertion():
    store, (old, new) = store_with(b"one\n", b"one\ntwo\n")
    assert count_changes(store, {b"a.txt": (MODE, old)},
                         {b"a.txt": (MODE, new)}) == (1, 0)


def test_a_rewritten_line_is_one_of_each():
    store, (old, new) = store_with(b"one\n", b"uno\n")
    assert count_changes(store, {b"a.txt": (MODE, old)},
                         {b"a.txt": (MODE, new)}) == (1, 1)


def test_an_unchanged_path_is_never_read():
    # Same blob on both sides, so there is nothing to diff and the
    # comparison must not reach for the object at all.
    assert count_changes(MemoryObjectStore(), {b"a.txt": (MODE, b"a" * 40)},
                         {b"a.txt": (MODE, b"a" * 40)}) == (0, 0)


def test_a_created_path_gets_its_mode_line():
    assert mode_lines({},
                      {b"a.txt":
                       (MODE, b"a" * 40)}) == [" create mode 100644 a.txt"]


def test_an_executable_says_so():
    assert mode_lines(
        {}, {b"run.sh":
             (EXECUTABLE, b"a" * 40)}) == [" create mode 100755 run.sh"]


def test_a_removed_path_gets_a_delete_line():
    assert mode_lines({b"a.txt": (MODE, b"a" * 40)},
                      {}) == [" delete mode 100644 a.txt"]


def test_a_path_that_only_changed_gets_no_mode_line():
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"b" * 40)}
    assert mode_lines(before, after) == []
