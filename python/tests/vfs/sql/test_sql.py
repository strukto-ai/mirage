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

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from mirage.core.sql.constants import DEFAULT_CHUNK_SIZE
from mirage.io.stream import materialize
from mirage.observe.context import RecordingScope
from mirage.types import CapacityState, FileType, MountMode, PathSpec
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.sql import SqlVFS
from mirage.vfs.sql.types import SqlStatement
from mirage.vfs.testing import MutationFixture, check_mutation_contract
from mirage.workspace import Workspace
from mirage.workspace.record.sql import SqlRecordClient
from mirage.workspace.store.sql import SqlWorkspaceStateStore

SCRATCH = MutationFixture(
    PathSpec(virtual="/sql/scratch", directory="/sql", vfs_path="scratch")
)
CS = DEFAULT_CHUNK_SIZE


def at(p: str) -> PathSpec:
    return PathSpec.from_str_path(p)


async def whole(vfs: SqlVFS, p: str) -> bytes:
    return await materialize(await vfs.read(at(p)))


@pytest_asyncio.fixture
async def vfs() -> AsyncIterator[SqlVFS]:
    v = SqlVFS()
    yield v
    await v.close()


@pytest.mark.asyncio
async def test_it_passes_the_mutation_contract(vfs: SqlVFS):
    await vfs.mkdir(at("/scratch"))
    await check_mutation_contract(vfs, SCRATCH)


@pytest.mark.asyncio
async def test_a_file_across_chunk_boundaries_reads_whole_and_in_windows(
    vfs: SqlVFS,
):
    data = bytes(i % 251 for i in range(CS * 2 + 5))
    await vfs.write(at("/big"), data)
    assert (await vfs.stat(at("/big"))).size == len(data)
    assert await whole(vfs, "/big") == data
    assert await vfs.read(at("/big"), CS - 2, 6) == data[CS - 2 : CS + 4]
    assert await vfs.read(at("/big"), CS * 2, None) == data[CS * 2 :]
    rows = vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_data")
    assert rows[0]["n"] == 3


@pytest.mark.asyncio
async def test_append_crosses_a_chunk_edge_and_truncate_pads_zeros(
    vfs: SqlVFS,
):
    await vfs.write(at("/f"), b"a" * (CS - 1))
    await vfs.append(at("/f"), b"xyz")
    grown = await whole(vfs, "/f")
    assert len(grown) == CS + 2
    assert grown[-3:] == b"xyz"
    await vfs.truncate(at("/f"), 2)
    await vfs.truncate(at("/f"), 5)
    assert await whole(vfs, "/f") == b"aa\x00\x00\x00"
    await vfs.truncate(at("/missing"), 3, True)
    assert not await vfs.exists(at("/missing"))


@pytest.mark.asyncio
async def test_a_stream_lands_as_it_arrives(vfs: SqlVFS):

    async def parts() -> AsyncIterator[bytes]:
        yield b"ab"
        yield b"cd"

    await vfs.write(at("/s"), parts())
    assert await whole(vfs, "/s") == b"abcd"
    await vfs.append(at("/s"), parts())
    assert await whole(vfs, "/s") == b"abcdabcd"


@pytest.mark.asyncio
async def test_a_tree_moves_with_one_entry_and_goes_whole(vfs: SqlVFS):
    await vfs.mkdir(at("/a/b"), parents=True)
    await vfs.write(at("/a/b/f"), b"hi")
    await vfs.rename(at("/a"), at("/z"))
    assert await whole(vfs, "/z/b/f") == b"hi"
    assert not await vfs.exists(at("/a"))
    with pytest.raises(OSError):
        await vfs.rename(at("/z"), at("/z/b/in"))
    await vfs.rm_r(at("/z"))
    assert await vfs.readdir(at("/")) == []
    rows = vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_inode")
    assert rows[0]["n"] == 1


@pytest.mark.asyncio
async def test_copy_stays_inside_the_database(vfs: SqlVFS):
    await vfs.write(at("/src"), b"copied")
    await vfs.copy(at("/src"), at("/dst"))
    assert await whole(vfs, "/dst") == b"copied"
    assert await whole(vfs, "/src") == b"copied"


@pytest.mark.asyncio
async def test_a_numeric_owner_is_kept_and_a_name_goes_to_the_overlay(
    vfs: SqlVFS,
):
    await vfs.write(at("/o"), b"x")
    residual = await vfs.setattr(at("/o"), mode=0o600, uid=1000, gid="staff")
    assert residual == {"gid": "staff"}
    st = await vfs.stat(at("/o"))
    assert (st.mode, st.uid, st.gid) == (0o600, 1000, None)


@pytest.mark.asyncio
async def test_a_database_agentfs_made_mounts_at_its_own_chunk_size():
    driver = SqliteDriver()
    driver.batch(
        [
            SqlStatement(
                "CREATE TABLE fs_config (key TEXT PRIMARY KEY,"
                " value TEXT NOT NULL)"
            ),
            SqlStatement("INSERT INTO fs_config VALUES ('chunk_size', '4')"),
            SqlStatement(
                "CREATE TABLE fs_inode (ino INTEGER PRIMARY KEY AUTOINCREMENT,"
                " mode INTEGER NOT NULL, nlink INTEGER NOT NULL DEFAULT 0,"
                " uid INTEGER NOT NULL DEFAULT 0, gid INTEGER NOT NULL DEFAULT 0,"
                " size INTEGER NOT NULL DEFAULT 0, atime INTEGER NOT NULL,"
                " mtime INTEGER NOT NULL, ctime INTEGER NOT NULL,"
                " rdev INTEGER NOT NULL DEFAULT 0,"
                " atime_nsec INTEGER NOT NULL DEFAULT 0,"
                " mtime_nsec INTEGER NOT NULL DEFAULT 0,"
                " ctime_nsec INTEGER NOT NULL DEFAULT 0)"
            ),
            SqlStatement(
                "CREATE TABLE fs_dentry (id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " name TEXT NOT NULL, parent_ino INTEGER NOT NULL,"
                " ino INTEGER NOT NULL, UNIQUE(parent_ino, name))"
            ),
            SqlStatement(
                "CREATE TABLE fs_data (ino INTEGER NOT NULL,"
                " chunk_index INTEGER NOT NULL, data BLOB NOT NULL,"
                " PRIMARY KEY (ino, chunk_index))"
            ),
            SqlStatement(
                "CREATE TABLE fs_symlink (ino INTEGER PRIMARY KEY,"
                " target TEXT NOT NULL)"
            ),
            SqlStatement(
                "INSERT INTO fs_inode (ino, mode, nlink, atime, mtime,"
                " ctime) VALUES (1, 16877, 1, 0, 0, 0)"
            ),
            SqlStatement(
                "INSERT INTO fs_inode (ino, mode, nlink, size, atime,"
                " mtime, ctime) VALUES (2, 33188, 2, 10, 0, 0, 0)"
            ),
            SqlStatement(
                "INSERT INTO fs_dentry (name, parent_ino, ino)"
                " VALUES ('notes.txt', 1, 2)"
            ),
            SqlStatement(
                "INSERT INTO fs_dentry (name, parent_ino, ino)"
                " VALUES ('link.txt', 1, 2)"
            ),
            SqlStatement(
                "INSERT INTO fs_data VALUES (2, 0, x'68656c6c'),"
                " (2, 1, x'6f20776f'), (2, 2, x'726c')"
            ),
        ]
    )
    vfs = SqlVFS(driver=driver)
    try:
        assert await whole(vfs, "/notes.txt") == b"hello worl"
        await vfs.append(at("/notes.txt"), b"d!")
        assert await whole(vfs, "/link.txt") == b"hello world!"
        rows = driver.query(
            "SELECT length(data) AS n FROM fs_data"
            " WHERE ino = 2 ORDER BY chunk_index"
        )
        assert [r["n"] for r in rows] == [4, 4, 4]
        await vfs.unlink(at("/notes.txt"))
        assert await whole(vfs, "/link.txt") == b"hello world!"
        assert (
            driver.query("SELECT nlink FROM fs_inode WHERE ino = 2")[0][
                "nlink"
            ]
            == 1
        )
    finally:
        await vfs.close()
        driver.close()


@pytest.mark.asyncio
async def test_it_writes_the_tables_agentfs_reads():
    driver = SqliteDriver()
    vfs = SqlVFS(driver=driver)
    try:
        await vfs.mkdir(at("/d"))
        await vfs.write(at("/d/f"), b"hi")
        config = driver.query("SELECT key, value FROM fs_config ORDER BY key")
        assert config == [
            {"key": "chunk_size", "value": str(CS)},
            {"key": "schema_version", "value": "0.4"},
        ]
        tree = driver.query(
            "SELECT d.name, i.mode, i.nlink, i.size FROM fs_dentry d"
            " JOIN fs_inode i ON i.ino = d.ino ORDER BY d.name"
        )
        assert tree == [
            {"name": "d", "mode": 0o40755, "nlink": 1, "size": 0},
            {"name": "f", "mode": 0o100644, "nlink": 1, "size": 2},
        ]
        assert (await vfs.stat(at("/d/f"))).type == FileType.FILE
    finally:
        await vfs.close()
        driver.close()


@pytest.mark.asyncio
async def test_a_cas_record_lands_only_at_the_generation_it_expects():
    driver = SqliteDriver()
    records = SqlRecordClient(driver, "w/sessions/")
    assert await records.cas_put("s", {"generation": 1, "cwd": "/"}, 0)
    assert not await records.cas_put("s", {"generation": 1, "cwd": "/x"}, 0)
    assert await records.cas_put("s", {"generation": 2, "cwd": "/y"}, 1)
    assert not await records.cas_put("s", {"generation": 3, "cwd": "/z"}, 1)
    assert (await records.get("s"))[0] == {"generation": 2, "cwd": "/y"}
    await records.put("legacy", {"cwd": "/"})
    await records.put("legacy", {"cwd": "/"})
    assert await records.cas_put("legacy", {"generation": 1, "cwd": "/a"}, 0)
    assert await SqlRecordClient(driver, "other/").list_names() == []
    assert await records.list_names() == ["legacy", "s"]
    driver.close()


@pytest.mark.asyncio
async def test_the_next_workspace_on_the_file_keeps_cwd_and_env(tmp_path):
    path = str(tmp_path / "state.db")

    def open_workspace() -> Workspace:
        return Workspace(
            {"/work": SqlVFS(path)},
            mode=MountMode.WRITE,
            workspace_id="w1",
            store=SqlWorkspaceStateStore(SqliteDriver(path), owns_driver=True),
            owns_store=True,
        )

    first = open_workspace()
    try:
        r = await first.shell("mkdir -p /work/p && cd /work/p && export A=1")
        assert r.exit_code == 0
    finally:
        await first.close()
    second = open_workspace()
    try:
        r = await second.shell('pwd; echo "A=$A"')
        assert await r.stdout_str() == "/work/p\nA=1\n"
    finally:
        await second.close()


@pytest.mark.asyncio
async def test_the_shell_runs_and_a_reopened_file_keeps_what_was_written(
    tmp_path,
):
    path = str(tmp_path / "fs.db")
    first = Workspace({"/work": SqlVFS(path)}, mode=MountMode.WRITE)
    try:
        r = await first.shell(
            "mkdir -p /work/out && printf 'b\\na\\n' > /work/out/x.txt"
            " && mv /work/out/x.txt /work/out/y.txt && sort /work/out/y.txt"
        )
        assert r.exit_code == 0
        assert await r.stdout_str() == "a\nb\n"
    finally:
        await first.close()
    second = Workspace({"/work": SqlVFS(path)}, mode=MountMode.WRITE)
    try:
        r = await second.shell("ls /work/out && cat /work/out/y.txt")
        assert await r.stdout_str() == "y.txt\nb\na\n"
    finally:
        await second.close()


@pytest.mark.asyncio
async def test_a_snapshot_carries_the_files_into_a_fresh_mount():
    source = SqlVFS()
    ws = Workspace({"/w": source}, mode=MountMode.WRITE)
    try:
        r = await ws.shell(
            "mkdir -p /w/d && printf hi > /w/d/f && chmod 600 /w/d/f"
        )
        assert r.exit_code == 0
        state = source.get_state()
    finally:
        await ws.close()
    assert state["config"] == {}
    assert state["files"] == {"/d/f": b"hi"}
    assert state["dirs"] == ["/", "/d"]
    copy = SqlVFS()
    copy.load_state(state)
    try:
        assert await whole(copy, "/d/f") == b"hi"
        assert (await copy.stat(at("/d/f"))).mode == 0o600
        assert (await copy.stat(at("/d"))).type == FileType.DIRECTORY
    finally:
        await copy.close()


@pytest.mark.asyncio
async def test_an_uncapped_database_grows(vfs: SqlVFS):
    assert (await vfs.capacity()).state == CapacityState.ELASTIC
    assert vfs.storage_location() == "sql::memory:"


@pytest.mark.asyncio
async def test_its_ops_are_recorded_under_its_own_name(vfs: SqlVFS):
    path = at("/f")
    scope = RecordingScope()
    await vfs.write(path, b"hi")
    assert await vfs.read(path, 0, 2) == b"hi"
    scope.close()
    assert [(r.op, r.source) for r in scope.records] == [
        ("write", "sql"),
        ("read", "sql"),
    ]


def test_it_takes_a_path_or_a_driver_not_both():
    with pytest.raises(ValueError, match="a path or a driver, not both"):
        SqlVFS(":memory:", driver=SqliteDriver())
