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

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.data import cut_bytes, place_bytes, read_bytes
from mirage.core.sql.inode import Inode, by_ino
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.types import SqlStatement


def _accessor(chunk_size: int) -> SqlAccessor:
    driver = SqliteDriver()
    driver.batch(
        [
            SqlStatement(
                "CREATE TABLE fs_config (key TEXT PRIMARY KEY,"
                " value TEXT NOT NULL)"
            ),
            SqlStatement(
                "INSERT INTO fs_config VALUES ('chunk_size', ?)",
                (str(chunk_size),),
            ),
        ]
    )
    accessor = SqlAccessor(driver)
    assert accessor.chunk_size() == chunk_size
    return accessor


def _file(size: int) -> Inode:
    return Inode(
        ino=7,
        mode=0o100644,
        nlink=1,
        uid=0,
        gid=0,
        size=size,
        atime=0,
        atime_nsec=0,
        mtime=0,
        mtime_nsec=0,
        ctime=0,
        ctime_nsec=0,
    )


def _rows(accessor: SqlAccessor) -> list[bytes]:
    rows = accessor.query(
        "SELECT data FROM fs_data WHERE ino = 7 ORDER BY chunk_index"
    )
    return [bytes(r["data"] or b"") for r in rows]


def test_a_sparse_file_reads_its_holes_as_zeros():
    accessor = _accessor(4)
    accessor.batch(place_bytes(accessor, by_ino(7), None, 8, b"zz"))
    assert read_bytes(accessor, _file(12)) == b"\x00" * 8 + b"zz\x00\x00"
    assert read_bytes(accessor, _file(12), 7, 2) == b"\x00z"


def test_a_write_keeps_the_bytes_its_edge_rows_held():
    accessor = _accessor(4)
    accessor.batch(place_bytes(accessor, by_ino(7), None, 0, b"abcdefghij"))
    accessor.batch(place_bytes(accessor, by_ino(7), _file(10), 3, b"XYZ"))
    assert _rows(accessor) == [b"abcX", b"YZgh", b"ij"]


def test_a_cut_drops_the_rows_past_it_and_trims_the_last():
    accessor = _accessor(4)
    accessor.batch(place_bytes(accessor, by_ino(7), None, 0, b"abcdefghij"))
    accessor.batch(cut_bytes(accessor, _file(10), 5))
    assert _rows(accessor) == [b"abcd", b"e"]
    assert cut_bytes(accessor, _file(5), 9) == []
