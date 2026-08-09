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

import zlib

import pytest

from mirage.commands.builtin.generic.gzip import extract_level
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.workspace.executor.command.flags import parse_flags


def _level(argv: list[str]) -> int:
    parsed = parse_flags(argv, SPECS["gzip"], "gzip", "/")
    return extract_level(FlagView(parsed.flag_kwargs, spec=SPECS["gzip"]))


@pytest.mark.parametrize("digit", list(range(1, 10)))
def test_every_digit_flag_selects_its_level(digit: int):
    """-1..-9 each select their own level, including -1.

    ``-1`` is the one digit the parser disambiguates (``args_1``), so a
    bag read by the bare digit missed it and silently compressed at
    zlib's default.
    """
    assert _level([f"-{digit}"]) == digit


def test_no_digit_flag_keeps_the_zlib_default():
    assert _level([]) == zlib.Z_DEFAULT_COMPRESSION


def test_the_highest_digit_wins():
    """GNU takes the last level flag; the parser leaves all of them set."""
    assert _level(["-1", "-9"]) == 9
