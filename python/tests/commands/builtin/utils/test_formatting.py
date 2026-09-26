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

from mirage.commands.builtin.utils import formatting
from mirage.types import FileStat, FileType


def test_to_number_gnu_awk_coercion():
    assert formatting.to_number("3") == 3.0
    assert formatting.to_number("2.5x") == 2.5
    assert formatting.to_number("abc") == 0.0
    assert formatting.to_number(" -4.5 ") == -4.5
    assert formatting.to_number("1e3zzz") == 1000.0


def test_format_number_collapses_integral_floats():
    assert formatting.format_number(60.0) == "60"
    assert formatting.format_number(5.5) == "5.5"


def test_find_ls_and_ls_show_the_year_for_an_old_or_future_time():
    # GNU: a time older than the recent window, or in the future, shows
    # `Mon DD  YYYY` in place of `HH:MM`. findutils' window is 180 days
    # back and an hour ahead; ls's is half a year back and never ahead.
    old = FileStat(name="old",
                   size=1,
                   modified="2020-01-02T03:04:00Z",
                   type=FileType.FILE)
    assert formatting.format_find_ls(
        old, None).endswith("        1 Jan  2  2020 old")
    assert formatting.format_ls_long([old])[0].endswith(" 1 Jan  2  2020 old")
    far = FileStat(name="far",
                   size=1,
                   modified="2999-09-06T04:49:00Z",
                   type=FileType.FILE)
    assert formatting.format_find_ls(far, None).endswith(" Sep  6  2999 far")
    assert formatting.format_ls_long([far])[0].endswith(" Sep  6  2999 far")


@pytest.mark.parametrize(
    "text,expected",
    [
        ("K", formatting.BlockSize(1024, "K")),
        ("KiB", formatting.BlockSize(1024, "KiB")),
        ("1K", formatting.BlockSize(1024, "")),
        ("KB", formatting.BlockSize(1000, "kB")),
        ("M", formatting.BlockSize(1024 * 1024, "M")),
        ("4", formatting.BlockSize(4, "")),
        ("2K", formatting.BlockSize(2048, "")),
        ("human-readable", formatting.BlockSize(1024, "", 1024)),
        ("si", formatting.BlockSize(1000, "", 1000)),
        ("k", formatting.BlockSize(1024, "K")),
        ("1kB", formatting.BlockSize(1000, "")),
        ("E", formatting.BlockSize(1024**6, "E")),
        ("15E", formatting.BlockSize(15 * 1024**6, "")),
        ("18EB", formatting.BlockSize(18 * 1000**6, "")),
        (" 1", formatting.BlockSize(1, "")),
        ("+1", formatting.BlockSize(1, "")),
        (" +1", formatting.BlockSize(1, "")),
        ("+1K", formatting.BlockSize(1024, "")),
        (" 1K", formatting.BlockSize(1024, "")),
        # xstrtoumax's three refusals, measured on coreutils 9.7.
        ("bogus", formatting.BlockSizeRefusal.INVALID),
        # strtol's blanks and `+` are skipped only in front of a digit.
        ("+K", formatting.BlockSizeRefusal.INVALID),
        (" K", formatting.BlockSizeRefusal.INVALID),
        ("+ 1", formatting.BlockSizeRefusal.INVALID),
        ("+", formatting.BlockSizeRefusal.INVALID),
        (" ", formatting.BlockSizeRefusal.INVALID),
        ("0", formatting.BlockSizeRefusal.INVALID),
        ("0K", formatting.BlockSizeRefusal.INVALID),
        ("0KB", formatting.BlockSizeRefusal.INVALID),
        ("00KiB", formatting.BlockSizeRefusal.INVALID),
        ("", formatting.BlockSizeRefusal.INVALID),
        ("iB", formatting.BlockSizeRefusal.INVALID),
        ("B", formatting.BlockSizeRefusal.INVALID),
        ("-1K", formatting.BlockSizeRefusal.INVALID),
        ("HUMAN", formatting.BlockSizeRefusal.INVALID),
        ("KiX", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("Kx", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1x", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1e", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1p", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1R", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1Ki", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1.5K", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("1 ", formatting.BlockSizeRefusal.INVALID_SUFFIX),
        ("Y", formatting.BlockSizeRefusal.TOO_LARGE),
        ("16E", formatting.BlockSizeRefusal.TOO_LARGE),
        ("18446744073709551616", formatting.BlockSizeRefusal.TOO_LARGE),
        ("18446744073709551615", formatting.BlockSize(18446744073709551615,
                                                      "")),
    ])
def test_parse_block_size_reads_gnu_units(text, expected):
    assert formatting.parse_block_size(text) == expected


def test_scaled_size_rounds_up_like_gnu():
    # `ls -l --block-size=K` on 6 bytes prints 1K; =4 on 10 bytes prints 3.
    assert formatting.scaled_size(6, formatting.BlockSize(1024, "K"),
                                  False) == "1K"
    assert formatting.scaled_size(10, formatting.BlockSize(4, ""),
                                  False) == "3"
    assert formatting.scaled_size(10, formatting.BlockSize(1000, "kB"),
                                  False) == "1kB"
    assert formatting.scaled_size(1500, formatting.BlockSize(1000, "", 1000),
                                  False) == "1.5k"
    assert formatting.scaled_size(1500, formatting.BlockSize(1024, "", 1024),
                                  False) == "1.5K"
    assert formatting.scaled_size(1500, None, True) == "1.5K"
    assert formatting.scaled_size(1500, None, False) == "1500"


@pytest.mark.parametrize("size,modified,expected", [
    (None, "2020-01-02T03:04:00Z", "- Jan  2  2020"),
    (0, None, "0 -"),
    (None, None, "- -"),
])
def test_size_and_time_are_independently_unknown(size, modified, expected):
    row = FileStat(name="file",
                   type=FileType.FILE,
                   size=size,
                   modified=modified)
    assert formatting.format_ls_long([row])[0].endswith(expected + " file")
