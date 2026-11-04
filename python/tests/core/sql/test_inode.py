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
from mirage.core.sql.constants import MAX_PARAMS
from mirage.core.sql.inode import (
    Inode,
    by_entry,
    by_ino,
    inode_stat,
    insert_rows,
    iso_of,
    stamp_of,
)
from mirage.types import FileType
from mirage.vfs.sql.driver import SqliteDriver


def _node(mode: int, uid: int = 0) -> Inode:
    return Inode(
        ino=2,
        mode=mode,
        nlink=1,
        uid=uid,
        gid=0,
        size=3,
        atime=0,
        atime_nsec=0,
        mtime=1_700_000_000,
        mtime_nsec=123_456_000,
        ctime=0,
        ctime_nsec=0,
    )


def test_a_stamp_round_trips_to_the_microsecond():
    assert stamp_of("2023-11-14T22:13:20.123456Z") == (
        1_700_000_000,
        123_456_000,
    )
    assert iso_of(1_700_000_000, 123_456_000) == "2023-11-14T22:13:20.123456Z"
    assert iso_of(1_700_000_000, 0) == "2023-11-14T22:13:20Z"


def test_an_inode_stats_as_its_kind_with_owner_zero_as_none():
    file = inode_stat("/d/a.txt", _node(0o100640))
    assert (file.name, file.type, file.size, file.mode, file.uid) == (
        "a.txt",
        FileType.FILE,
        3,
        0o640,
        None,
    )
    assert file.modified == "2023-11-14T22:13:20.123456Z"
    folder = inode_stat("/d", _node(0o40755, uid=1000))
    assert (folder.type, folder.size, folder.uid) == (
        FileType.DIRECTORY,
        None,
        1000,
    )


def test_an_entry_ref_nests_under_its_parent():
    ref = by_entry(by_entry(by_ino(1), "a"), "b")
    assert ref.params == ("a", "b")
    assert ref.sql.count("SELECT ino FROM fs_dentry") == 2


def test_rows_split_where_a_statement_would_bind_too_many():
    rows = [(i, b"x") for i in range(MAX_PARAMS)]
    statements = insert_rows("INSERT INTO t (a, b)", "(?, ?)", rows)
    assert all(len(s.params) <= MAX_PARAMS for s in statements)
    assert sum(len(s.params) for s in statements) == 2 * MAX_PARAMS


def test_a_fresh_database_holds_the_root_alone():
    driver = SqliteDriver()
    accessor = SqlAccessor(driver)
    accessor.chunk_size()
    rows = accessor.query("SELECT ino, mode, nlink FROM fs_inode")
    assert rows == [{"ino": 1, "mode": 0o40755, "nlink": 1}]
    driver.close()
