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

from mirage.commands.builtin.utils.formatting import (_human_size,
                                                      format_ls_long)
from mirage.types import FileStat, FileType


def test_human_size_bytes():
    assert _human_size(500) == "500B"


def test_human_size_kilobytes():
    assert _human_size(1024) == "1.0K"


def test_human_size_fractional_rounds_not_floored():
    assert _human_size(1536) == "1.5K"
    assert _human_size(1024 * 1024 + 512 * 1024) == "1.5M"


def test_format_ls_long_regular_file():
    stat = FileStat(name="file.txt",
                    size=5,
                    type=FileType.TEXT,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat])
    assert line == "-rw-r--r-- 1 user user 5 Jan  1 00:00 file.txt"


def test_format_ls_long_directory():
    stat = FileStat(name="sub",
                    size=0,
                    type=FileType.DIRECTORY,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat])
    assert line.startswith("drwxr-xr-x ")
    assert line.endswith(" sub")


def test_format_ls_long_size_alignment():
    stats = [
        FileStat(name="a",
                 size=5,
                 type=FileType.TEXT,
                 modified="2026-01-01T00:00:00Z"),
        FileStat(name="b",
                 size=1234,
                 type=FileType.TEXT,
                 modified="2026-01-01T00:00:00Z"),
    ]
    lines = format_ls_long(stats)
    assert "    5 Jan  1 00:00 a" in lines[0]
    assert " 1234 Jan  1 00:00 b" in lines[1]


def test_format_ls_long_human_size():
    stat = FileStat(name="big",
                    size=2048,
                    type=FileType.TEXT,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat], human=True)
    assert "2.0K" in line
    assert " 2048 " not in line


def test_format_ls_long_missing_modified():
    stat = FileStat(name="x", size=0, type=FileType.TEXT, modified=None)
    [line] = format_ls_long([stat])
    assert "Jan  1 00:00" in line
