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

from mirage.commands.cli.builtin.git.render import (branch_line, long_format,
                                                    quote_path, short_format,
                                                    short_line)
from mirage.commands.cli.builtin.git.types import StatusEntry


def row(path: str, index: str, tree: str, original: str | None = None):
    """One status row.

    Args:
        path (str): repository-relative path.
        index (str): the left column.
        tree (str): the right column.
        original (str | None): the renamed-from path.
    """
    return StatusEntry(path, index, tree, original)


# Each row is (path, whether the machine formats quote it, whether the
# human one does). Pinned against git 2.47: a space forces quoting only
# where the output is meant to be split on whitespace.
QUOTING = [
    ("plain.txt", "plain.txt", "plain.txt"),
    ("has space.txt", '"has space.txt"', "has space.txt"),
    ("quo\"te.txt", '"quo\\"te.txt"', '"quo\\"te.txt"'),
    ("back\\slash.txt", '"back\\\\slash.txt"', '"back\\\\slash.txt"'),
    ("héllo.txt", '"h\\303\\251llo.txt"', '"h\\303\\251llo.txt"'),
    ("tab\there.txt", '"tab\\there.txt"', '"tab\\there.txt"'),
]


@pytest.mark.parametrize("path,machine,human", QUOTING)
def test_quoting_matches_git(path, machine, human):
    assert quote_path(path, True) == machine
    assert quote_path(path, False) == human


def test_a_short_line_is_two_columns_then_the_path():
    assert short_line(row("a.txt", "M", " ")) == "M  a.txt"


def test_a_rename_names_both_sides():
    assert short_line(row("new.txt", "R", " ",
                          "old.txt")) == "R  old.txt -> new.txt"


def test_the_branch_line_is_absent_without_the_flag():
    assert short_format([row("a.txt", "?", "?")], None) == "?? a.txt\n"


def test_the_branch_line_leads_when_asked():
    header = branch_line("main", None, False)
    assert short_format([], header) == "## main\n"


def test_an_unborn_branch_says_so():
    assert branch_line("main", None, True) == "## No commits yet on main"


def test_a_detached_head_has_no_branch_to_name():
    assert branch_line(None, "abc1234", False) == "## HEAD (no branch)"


def test_a_clean_tree_is_two_lines():
    assert long_format(
        [], "main", None, False, False,
        False) == ("On branch main\nnothing to commit, working tree clean\n")


def test_an_unborn_repository_announces_it_before_anything_else():
    body = long_format([], "main", None, True, False, False)
    assert body.splitlines()[:3] == ["On branch main", "", "No commits yet"]


def test_the_unborn_repository_offers_a_different_unstage_hint():
    # `git restore --staged` has nothing to restore to before the first
    # commit, so git names `git rm --cached` instead.
    body = long_format([row("a.txt", "A", " ")], "main", None, True, False,
                       False)
    assert '(use "git rm --cached <file>..." to unstage)' in body


def test_a_merge_in_progress_drops_the_unstage_hint():
    body = long_format([row("a.txt", "M", " ")], "main", None, False, True,
                       False)
    assert "to unstage" not in body
    assert "All conflicts fixed but you are still merging." in body


def test_an_unresolved_merge_says_which_conflicts_remain():
    body = long_format([row("f.txt", "U", "U")], "main", None, False, True,
                       False)
    assert "You have unmerged paths." in body
    assert "\tboth modified:   f.txt" in body


def test_every_conflict_shape_has_its_own_label():
    labels = {
        ("D", "D"): "both deleted:",
        ("A", "U"): "added by us:",
        ("U", "D"): "deleted by them:",
        ("U", "A"): "added by them:",
        ("D", "U"): "deleted by us:",
        ("A", "A"): "both added:",
        ("U", "U"): "both modified:",
    }
    for (index, tree), label in labels.items():
        body = long_format([row("f.txt", index, tree)], "main", None, False,
                           True, False)
        assert f"\t{label:<17}f.txt" in body


def test_a_staged_change_silences_the_trailer():
    body = long_format([row("a.txt", "M", " ")], "main", None, False, False,
                       False)
    assert "nothing to commit" not in body
    assert "no changes added" not in body


def test_untracked_alone_says_nothing_was_added():
    body = long_format([row("a.txt", "?", "?")], "main", None, False, False,
                       False)
    assert body.endswith('nothing added to commit but untracked files '
                         'present (use "git add" to track)\n')


def test_hiding_untracked_changes_the_clean_line_rather_than_adding_one():
    body = long_format([], "main", None, False, False, True)
    assert body == ("On branch main\n"
                    "nothing to commit (use -u to show untracked files)\n")


def test_hiding_untracked_notes_the_omission_when_something_is_staged():
    body = long_format([row("a.txt", "M", " ")], "main", None, False, False,
                       True)
    assert body.endswith("Untracked files not listed (use -u option to show "
                         "untracked files)\n")


def test_the_two_sections_can_name_the_same_path():
    body = long_format([row("a.txt", "M", "M")], "main", None, False, False,
                       False)
    assert body.count("\tmodified:   a.txt") == 2
