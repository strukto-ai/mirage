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

from mirage.workspace.route import end_options_after_program


def rewrite(words: list[str]) -> list[str]:
    return end_options_after_program("python3", words)


def test_a_command_with_no_program_option_is_untouched():
    words = ["-c", "print(1)", "-u"]
    assert end_options_after_program("cat", words) == words


def test_the_marker_lands_after_the_payload_value():
    assert rewrite(["-c", "print(1)", "-u",
                    "x"]) == ["-c", "print(1)", "--", "-u", "x"]


def test_the_marker_lands_after_an_attached_payload_value():
    assert rewrite(["-cprint(1)", "-u"]) == ["-cprint(1)", "--", "-u"]


def test_a_value_option_before_the_payload_is_stepped_over():
    # -W takes a value, so `ignore` is not the first operand.
    assert rewrite(["-W", "ignore", "-c", "p",
                    "x"]) == ["-W", "ignore", "-c", "p", "--", "x"]


def test_a_typed_marker_survives_because_ours_is_added_anyway():
    # CPython stops parsing at -c and passes a later `--` through as
    # data, so the parser must eat ours and leave theirs.
    assert rewrite(["-c", "p", "--", "-u"]) == ["-c", "p", "--", "--", "-u"]


def test_a_payload_option_after_an_operand_belongs_to_the_program():
    # `python3 s.py -c x` runs s.py; the -c is the script's own.
    assert rewrite(["s.py", "-c", "x"]) == ["s.py", "-c", "x"]


def test_a_marker_before_the_payload_ends_the_scan():
    assert rewrite(["--", "-c", "x"]) == ["--", "-c", "x"]


def test_a_module_option_hands_off_the_same_way():
    assert rewrite(["-m", "json.tool",
                    "-h"]) == ["-m", "json.tool", "--", "-h"]


def test_a_payload_with_no_value_is_left_for_the_parser_to_refuse():
    # `python3 -c` must report the missing argument, not run a program
    # named `--`.
    assert rewrite(["-c"]) == ["-c"]
    assert rewrite(["-cprint(1)"]) == ["-cprint(1)"]


def test_nothing_is_added_when_no_words_follow_the_value():
    assert rewrite(["-c", "print(1)"]) == ["-c", "print(1)"]


def test_a_clustered_payload_hands_off_from_inside_the_cluster():
    # `python3 -uc 'p' -v` gives the program ['-c', '-v'] on CPython,
    # so the carrier is found by walking letters, not by prefix.
    assert rewrite(["-uc", "p", "-v",
                    "foo"]) == ["-uc", "p", "--", "-v", "foo"]


def test_a_clustered_attached_payload_hands_off_after_its_own_word():
    assert rewrite(["-ucp", "-v", "foo"]) == ["-ucp", "--", "-v", "foo"]


def test_a_clustered_payload_with_no_value_is_left_alone():
    assert rewrite(["-uc"]) == ["-uc"]


def test_a_long_value_option_before_the_payload_is_stepped_over():
    assert rewrite([
        "--check-hash-based-pycs", "never", "-c", "p", "-u", "z"
    ]) == ["--check-hash-based-pycs", "never", "-c", "p", "--", "-u", "z"]


def test_an_attached_long_value_option_consumes_only_its_own_word():
    assert rewrite([
        "--check-hash-based-pycs=never", "-c", "p", "-u", "z"
    ]) == ["--check-hash-based-pycs=never", "-c", "p", "--", "-u", "z"]


def test_an_attached_short_value_option_consumes_only_its_own_word():
    assert rewrite(["-Wignore", "-c", "p", "-u",
                    "z"]) == ["-Wignore", "-c", "p", "--", "-u", "z"]
