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

from mirage.types import PathSpec
from mirage.workspace.route.constants import (NO_FOLLOW_COMMANDS, dereferences,
                                              reports_link)


def test_stat_is_a_no_follow_command():
    """GNU stat lstats, so its operands must not be rewritten."""
    assert "stat" in NO_FOLLOW_COMMANDS


def test_bare_dash_l_dereferences():
    assert dereferences("stat", ["stat", "-L", "/data/link"]) is True


def test_clustered_short_flag_dereferences():
    assert dereferences("stat", ["stat", "-Lc", "%n", "/data/link"]) is True


def test_long_form_dereferences():
    assert dereferences("stat",
                        ["stat", "--dereference", "/data/link"]) is True


def test_absent_flag_does_not_dereference():
    assert dereferences("stat", ["stat", "/data/link"]) is False


def test_an_l_inside_a_format_value_does_not_dereference():
    """Only option words count, so `-c '%L'` must not trip the check."""
    assert dereferences("stat", ["stat", "-c", "%L", "/data/link"]) is False


def test_a_command_with_no_dereference_flag_is_never_affected():
    assert dereferences("rm", ["rm", "-L", "/data/link"]) is False


def test_flags_after_end_of_options_are_operands():
    assert dereferences("stat", ["stat", "--", "-L"]) is False


def test_a_pathspec_operand_is_not_read_as_a_flag():
    """Operands arrive classified as PathSpec, not str."""
    spec = PathSpec.from_str_path("/data/-L")
    assert dereferences("stat", ["stat", spec]) is False


def test_ls_reports_the_link_under_dash_l():
    """GNU ls -l shows a command-line link itself, not its target."""
    assert reports_link("ls", ["ls", "-l", "/data/link"]) is True


def test_ls_reports_the_link_under_dash_d():
    assert reports_link("ls", ["ls", "-d", "/data/link"]) is True


def test_ls_reports_the_link_in_a_flag_cluster():
    assert reports_link("ls", ["ls", "-la", "/data/link"]) is True


def test_bare_ls_dereferences_a_directory_link():
    assert reports_link("ls", ["ls", "/data/link"]) is False


def test_dash_capital_l_wins_over_the_no_follow_flags():
    """-L asks to dereference, which outranks -l's lstat default."""
    assert reports_link("ls", ["ls", "-l", "-L", "/data/link"]) is False


def test_a_command_with_no_no_follow_flag_is_never_affected():
    assert reports_link("cat", ["cat", "-l", "/data/link"]) is False


def test_file_lstats_like_stat():
    """GNU file describes a link; -L is what follows it."""
    assert "file" in NO_FOLLOW_COMMANDS
    assert dereferences("file", ["file", "-L", "/data/link"]) is True


def test_du_does_not_follow_a_link_operand():
    assert "du" in NO_FOLLOW_COMMANDS
    assert dereferences("du", ["du", "-L", "/data/link"]) is True


def test_find_link_options_are_last_wins():
    # GNU takes the last of -P/-H/-L: `find -L -P x` does not follow,
    # `find -P -L x` does.
    assert dereferences("find", ["find", "-L", "-P", "/data/link"]) is False
    assert dereferences("find", ["find", "-P", "-L", "/data/link"]) is True
    assert dereferences("find", ["find", "-L", "-P", "-L",
                                 "/data/link"]) is True
    assert dereferences("find", ["find", "-H", "/data/link"]) is True
    assert dereferences("find", ["find", "/data/link"]) is False


def test_find_link_options_only_count_before_the_operand():
    # -L after the start point is a predicate position, not a policy one.
    assert dereferences("find", ["find", "/data/link", "-L"]) is False
