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

from mirage.runtime.stat import posix_stat
from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.wasm.constants import (
    FT_CHR,
    FT_DIR,
    FT_REG,
    FT_SYMLINK,
    FT_UNKNOWN,
)
from mirage.runtime.wasm.stat import (
    filetype_of,
    pack_fdstat,
    pack_filestat,
    pack_prestat,
)
from mirage.utils.stat_view import CHAR_MODE, DIR_MODE, FILE_MODE, LINK_MODE


def test_record_sizes_match_the_preview1_layouts():
    assert len(pack_prestat(1)) == 8
    assert len(pack_fdstat(FT_REG)) == 24
    row = VFSStat(size=0, is_dir=False, mode=0o100644)
    assert len(pack_filestat(posix_stat(row, "/f", "/"), FT_REG)) == 64


def test_filetype_of_answers_a_stat_and_a_listing_row_alike():
    # One table for path_filestat_get and fd_readdir, so d_type never
    # disagrees with the stat: a character device lists as one.
    assert (
        filetype_of(
            VFSStat(
                size=3, is_dir=False, mode=LINK_MODE, mtime_ns=0, is_link=True
            )
        )
        == FT_SYMLINK
    )
    assert (
        filetype_of(VFSStat(size=0, is_dir=True, mode=DIR_MODE, mtime_ns=0))
        == FT_DIR
    )
    assert (
        filetype_of(VFSStat(size=1, is_dir=False, mode=FILE_MODE, mtime_ns=0))
        == FT_REG
    )
    assert (
        filetype_of(
            VFSEntry(path="/dev/null", size=0, is_dir=False, mode=CHAR_MODE)
        )
        == FT_CHR
    )
    assert (
        filetype_of(VFSEntry(path="/data/sub/", size=0, is_dir=True)) == FT_DIR
    )
    assert (
        filetype_of(VFSEntry(path="/data/bad", size=0, is_dir=False))
        == FT_UNKNOWN
    )
