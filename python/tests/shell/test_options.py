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

from mirage.shell.options import parse_option_word


def test_operand_is_not_an_option_word():
    assert parse_option_word("run.sh", None) is None


def test_end_of_options_markers_are_not_option_words():
    assert parse_option_word("--", None) is None
    assert parse_option_word("-", None) is None


def test_long_word_is_not_an_option_word():
    assert parse_option_word("--norc", None) is None


def test_minus_enables_and_plus_disables():
    assert parse_option_word("-x", None).settings == (("xtrace", True), )
    assert parse_option_word("+x", None).settings == (("xtrace", False), )


def test_cluster_keeps_written_order():
    word = parse_option_word("-eux", None)
    assert word.settings == (("errexit", True), ("nounset", True), ("xtrace",
                                                                    True))
    assert word.other == ""


def test_letters_naming_no_option_come_back_as_other():
    word = parse_option_word("-xc", None)
    assert word.settings == (("xtrace", True), )
    assert word.other == "c"
    assert word.consumed == 1


def test_o_names_the_option_in_the_next_word():
    word = parse_option_word("-o", "pipefail")
    assert word.settings == (("pipefail", True), )
    assert word.consumed == 2


def test_plus_o_disables_the_named_option():
    word = parse_option_word("+o", "xtrace")
    assert word.settings == (("xtrace", False), )
    assert word.consumed == 2


def test_o_is_read_from_anywhere_in_a_cluster():
    word = parse_option_word("-xo", "pipefail")
    assert word.settings == (("xtrace", True), ("pipefail", True))
    assert word.consumed == 2


def test_o_with_no_following_word_sets_nothing():
    word = parse_option_word("-o", None)
    assert word.settings == ()
    assert word.consumed == 1
