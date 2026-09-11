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

from mirage.shell.backticks import split_backtick_region
from mirage.shell.types import BacktickSegment


def test_a_single_pair_is_one_command():
    assert split_backtick_region("`cat s`") == [
        BacktickSegment("cat s", True, 1, 6)
    ]


def test_touching_pairs_are_split_with_the_text_between_them():
    raw = "`cat /data/secret` `echo ok`"
    segments = split_backtick_region(raw)
    assert [(s.text, s.command)
            for s in segments] == [("cat /data/secret", True), (" ", False),
                                   ("echo ok", True)]
    assert [raw[s.start:s.end]
            for s in segments] == ["cat /data/secret", " ", "echo ok"]


def test_escapes_in_a_command_are_resolved_and_the_span_stays_raw():
    raw = "`echo \\$x \\`y\\``"
    segment, = split_backtick_region(raw)
    assert segment.text == "echo $x `y`"
    assert raw[segment.start:segment.end] == "echo \\$x \\`y\\`"


def test_an_escaped_backslash_does_not_escape_the_closing_backtick():
    raw = "`echo a\\\\`b"
    command, literal = split_backtick_region(raw)
    assert command == BacktickSegment("echo a\\", True, 1, 9)
    assert literal == BacktickSegment("b", False, 10, 11)
