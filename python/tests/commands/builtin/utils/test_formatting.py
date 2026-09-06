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

from mirage.commands.builtin.utils.formatting import (format_find_ls,
                                                      format_ls_long,
                                                      format_number, to_number)
from mirage.types import FileStat, FileType


def test_to_number_gnu_awk_coercion():
    assert to_number("3") == 3.0
    assert to_number("2.5x") == 2.5
    assert to_number("abc") == 0.0
    assert to_number(" -4.5 ") == -4.5
    assert to_number("1e3zzz") == 1000.0


def test_format_number_collapses_integral_floats():
    assert format_number(60.0) == "60"
    assert format_number(5.5) == "5.5"


def test_find_ls_and_ls_show_the_year_for_an_old_or_future_time():
    # GNU: a time older than the recent window, or in the future, shows
    # `Mon DD  YYYY` in place of `HH:MM`. findutils' window is 180 days
    # back and an hour ahead; ls's is half a year back and never ahead.
    old = FileStat(name="old",
                   size=1,
                   modified="2020-01-02T03:04:00Z",
                   type=FileType.FILE)
    assert format_find_ls(old, None).endswith("        1 Jan  2  2020 old")
    assert format_ls_long([old])[0].endswith(" 1 Jan  2  2020 old")
    far = FileStat(name="far",
                   size=1,
                   modified="2999-09-06T04:49:00Z",
                   type=FileType.FILE)
    assert format_find_ls(far, None).endswith(" Sep  6  2999 far")
    assert format_ls_long([far])[0].endswith(" Sep  6  2999 far")
