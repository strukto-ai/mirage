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
from mirage.runtime.types import VFSStat
from mirage.utils.stat_view import ident


def test_a_file_row_reads_as_one_link_in_512_byte_blocks():
    row = VFSStat(size=1000, is_dir=False, mode=0o100644, mtime_ns=5)
    st = posix_stat(row, "/data/f.txt", "/data")
    assert (st.nlink, st.blocks, st.blksize) == (1, 2, 4096)
    assert (st.atime_ns, st.mtime_ns, st.ctime_ns) == (5, 5, 5)
    assert (st.ino, st.dev) == (ident("/data/f.txt"), ident("/data"))


def test_an_owner_and_access_time_the_row_lacks_take_the_fallback():
    row = VFSStat(size=0, is_dir=True, mode=0o40755)
    st = posix_stat(row, "/d", "/", uid=501, gid=20, unknown_ns=7)
    assert (st.nlink, st.uid, st.gid, st.mtime_ns, st.atime_ns) == (
        2,
        501,
        20,
        7,
        7,
    )


def test_the_row_owner_and_access_time_win():
    row = VFSStat(
        size=0,
        is_dir=False,
        mode=0o100600,
        mtime_ns=9,
        atime_ns=3,
        uid=0,
        gid=0,
    )
    st = posix_stat(row, "/f", "/", uid=501, gid=20)
    assert (st.uid, st.gid, st.atime_ns, st.mtime_ns) == (0, 0, 3, 9)


def test_ident_is_the_number_typescript_computes():
    # Pinned in runtime/stat.test.ts too: one path is one inode whichever
    # host answers.
    assert ident("/data/f.txt") == 213244078163057
    assert ident("/") == 192842459547137
