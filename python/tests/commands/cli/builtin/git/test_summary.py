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
from dulwich.object_store import BaseObjectStore, MemoryObjectStore
from dulwich.objects import Blob, Commit

from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.summary import (FileStat, diffstat,
                                                     mode_lines, report,
                                                     stat_line, stat_table)

MODE = 0o100644
EXECUTABLE = 0o100755

Tree = dict[bytes, tuple[int, bytes]]


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


def total_changes(store: BaseObjectStore, before: Tree,
                  after: Tree) -> tuple[int, int]:
    """The line totals the commit report sums out of the diffstat.

    Args:
        store (BaseObjectStore): the object database.
        before (Tree): the parent tree, path to (mode, blob id).
        after (Tree): the new tree, path to (mode, blob id).
    """
    stats = diffstat(store, before, after)
    return (sum(stat.insertions
                for stat in stats), sum(stat.deletions for stat in stats))


def pinned_commit(message: bytes) -> Commit:
    """A minimal commit whose id is stable enough to print.

    Args:
        message (bytes): the commit message.
    """
    commit = Commit()
    commit.tree = b"a" * 40
    commit.author = commit.committer = b"T <t@example.com>"
    commit.author_time = commit.commit_time = 0
    commit.author_timezone = commit.commit_timezone = 0
    commit.message = message
    return commit


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
    assert total_changes(store, {}, {b"a.txt": (MODE, sha)}) == (2, 0)


def test_a_removed_file_counts_every_line_as_a_deletion():
    store, (sha, ) = store_with(b"one\ntwo\n")
    assert total_changes(store, {b"a.txt": (MODE, sha)}, {}) == (0, 2)


def test_an_appended_line_is_one_insertion():
    store, (old, new) = store_with(b"one\n", b"one\ntwo\n")
    assert total_changes(store, {b"a.txt": (MODE, old)},
                         {b"a.txt": (MODE, new)}) == (1, 0)


def test_a_rewritten_line_is_one_of_each():
    store, (old, new) = store_with(b"one\n", b"uno\n")
    assert total_changes(store, {b"a.txt": (MODE, old)},
                         {b"a.txt": (MODE, new)}) == (1, 1)


def test_an_unchanged_path_is_never_read():
    # Same blob on both sides, so there is nothing to diff and the
    # comparison must not reach for the object at all.
    assert total_changes(MemoryObjectStore(), {b"a.txt": (MODE, b"a" * 40)},
                         {b"a.txt": (MODE, b"a" * 40)}) == (0, 0)


# Both report pins below reproduce a scratch-repo session against git
# 2.37: a binary blob counts as a changed file but zero lines, and in a
# mixed commit the untouched deletions clause drops off the line.
def test_report_counts_a_binary_file_but_no_lines():
    store, (bin_id, ) = store_with(b"A\x00B\x00C")
    commit = pinned_commit(b"add binary")
    out = report(store, commit, "main", {}, {b"blob.bin": (MODE, bin_id)}, 7,
                 False)
    assert out == (f"[main {short(commit.id, 7)}] add binary\n"
                   " 1 file changed, 0 insertions(+), 0 deletions(-)\n"
                   " create mode 100644 blob.bin\n").encode()


def test_report_mixes_binary_files_and_text_lines_like_git():
    store, (txt, bin_id) = store_with(b"x\ny\nz\n", b"DIFFERENT\x00BYTES")
    commit = pinned_commit(b"mixed")
    after = {b"text.txt": (MODE, txt), b"blob.bin": (MODE, bin_id)}
    out = report(store, commit, "main", {}, after, 7, False)
    assert out == (f"[main {short(commit.id, 7)}] mixed\n"
                   " 2 files changed, 3 insertions(+)\n"
                   " create mode 100644 blob.bin\n"
                   " create mode 100644 text.txt\n").encode()


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


def entry_stat(path: str, insertions: int, deletions: int) -> FileStat:
    return FileStat(path=path,
                    insertions=insertions,
                    deletions=deletions,
                    binary=False,
                    old_size=0,
                    new_size=0)


def test_diffstat_counts_lines_binaries_and_mode_changes():
    store, (old, new, bin_id) = store_with(b"one\n", b"one changed\n",
                                           b"\x00\x01binary")
    before = {b"a.txt": (MODE, old), b"tool": (MODE, old)}
    after = {
        b"a.txt": (MODE, new),
        b"tool": (EXECUTABLE, old),
        b"blob.bin": (MODE, bin_id),
    }
    stats = diffstat(store, before, after)
    assert [(s.path, s.insertions, s.deletions, s.binary) for s in stats] == [
        ("a.txt", 1, 1, False),
        ("blob.bin", 0, 0, True),
        ("tool", 0, 0, False),
    ]
    assert stats[1].new_size == len(b"\x00\x01binary")


# The geometry rows are pinned against git 2.50.1 (scratch repo, piped
# output): scaling at 21 graph columns, left elision at a component
# boundary, the bare `| 0` mode-only row, and the Bin byte report.
def test_stat_table_matches_gits_scaled_layout():
    stats = [
        FileStat("bin.dat", 0, 0, True, 0, 100),
        FileStat("deep/nested/dir/structure/a_rather_long_file_name_here.txt",
                 150, 0, False, 0, 0),
        FileStat("new.txt", 3, 0, False, 0, 0),
        FileStat("small.txt", 195, 0, False, 0, 0),
        FileStat("tiny.txt", 0, 1, False, 0, 0),
    ]
    assert stat_table(stats) == [
        " bin.dat                                            |"
        " Bin 0 -> 100 bytes",
        " .../dir/structure/a_rather_long_file_name_here.txt |"
        " 150 ++++++++++++++++",
        " new.txt                                            |   3 +",
        " small.txt                                          |"
        " 195 +++++++++++++++++++++",
        " tiny.txt                                           |   1 -",
        " 5 files changed, 348 insertions(+), 1 deletion(-)",
    ]


def test_stat_table_unscaled_when_the_graph_fits():
    assert stat_table([entry_stat("a.txt", 1, 1)]) == [
        " a.txt | 2 +-",
        " 1 file changed, 1 insertion(+), 1 deletion(-)",
    ]


def test_stat_table_mode_only_row_has_no_graph():
    assert stat_table([entry_stat("new.txt", 0, 0)]) == [
        " new.txt | 0",
        " 1 file changed, 0 insertions(+), 0 deletions(-)",
    ]
