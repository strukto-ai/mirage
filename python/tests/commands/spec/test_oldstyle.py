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

from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.oldstyle import expand_old_style

TAR = compile_spec(SPECS["tar"])


def test_bools_only_cluster_becomes_dashed_flags():
    old = expand_old_style(TAR, ["xz"])
    assert old.argv == ["-x", "-z"]
    assert old.origins == [0, 0]
    assert old.cluster == "xz"
    assert old.needs_value is None


def test_value_letter_pulls_the_next_word():
    old = expand_old_style(TAR, ["xzf", "a.tgz"])
    assert old.argv == ["-x", "-z", "-f", "a.tgz"]
    assert old.origins == [0, 0, 0, 1]


def test_operands_follow_the_cluster_arguments():
    old = expand_old_style(TAR, ["czf", "a.tgz", "one.txt", "two.txt"])
    assert old.argv == ["-c", "-z", "-f", "a.tgz", "one.txt", "two.txt"]
    assert old.origins == [0, 0, 0, 1, 2, 3]


def test_two_value_letters_consume_words_in_letter_order():
    old = expand_old_style(TAR, ["xfC", "a.tgz", "out", "one.txt"])
    assert old.argv == ["-x", "-f", "a.tgz", "-C", "out", "one.txt"]
    assert old.origins == [0, 0, 1, 0, 2, 3]


def test_value_letter_before_a_bool_letter_keeps_both():
    # GNU: `tar cfz a.tgz f` gzips, so z is a flag and not f's value.
    old = expand_old_style(TAR, ["cfz", "a.tgz", "one.txt"])
    assert old.argv == ["-c", "-f", "a.tgz", "-z", "one.txt"]


def test_argument_is_taken_verbatim_even_when_dashed():
    # GNU looks for an archive literally named -C here.
    old = expand_old_style(TAR, ["xzf", "-C", "out"])
    assert old.argv == ["-x", "-z", "-f", "-C", "out"]
    assert old.origins == [0, 0, 0, 1, 2]


def test_undeclared_letter_becomes_an_undeclared_flag_token():
    old = expand_old_style(TAR, ["xQz", "a.tgz"])
    assert old.argv == ["-x", "-Q", "-z", "a.tgz"]
    assert old.needs_value is None


def test_value_letter_off_the_end_of_the_line_reports_itself():
    old = expand_old_style(TAR, ["xzf"])
    assert old.needs_value == "f"


def test_second_value_letter_off_the_end_reports_itself():
    old = expand_old_style(TAR, ["cfC", "a.tar"])
    assert old.needs_value == "C"


def test_dashed_first_word_is_left_alone():
    old = expand_old_style(TAR, ["-x", "-z", "-f", "a.tgz"])
    assert old.argv == ["-x", "-z", "-f", "a.tgz"]
    assert old.origins == [0, 1, 2, 3]
    assert old.cluster is None


def test_double_dash_first_word_is_left_alone():
    old = expand_old_style(TAR, ["--extract", "--file", "a.tgz"])
    assert old.argv == ["--extract", "--file", "a.tgz"]
    assert old.cluster is None


def test_empty_argv_is_left_alone():
    old = expand_old_style(TAR, [])
    assert old.argv == []
    assert old.origins == []
    assert old.cluster is None


def test_empty_first_word_is_an_empty_cluster():
    # GNU reads `tar ""` as a cluster with no letters and refuses for
    # want of a mode, so the word is consumed, not treated as an operand.
    old = expand_old_style(TAR, ["", "one.txt"])
    assert old.argv == ["one.txt"]
    assert old.origins == [1]
    assert old.cluster == ""
