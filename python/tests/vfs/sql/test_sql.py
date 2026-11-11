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

import asyncio
import contextlib
import errno
import sqlite3
from collections.abc import AsyncIterator, Sequence

import pytest
import pytest_asyncio

from mirage.core.sql.constants import (
    DEFAULT_CHUNK_SIZE,
    DIR,
    FILE,
    clear_under,
)
from mirage.io.stream import materialize
from mirage.observe.context import RecordingScope
from mirage.types import CapacityState, FileType, MountMode, PathSpec
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.postgres import PostgresSqlDriver
from mirage.vfs.sql.sql import SqlVFS
from mirage.vfs.sql.types import SqlDialect, SqlDriver, SqlStatement
from mirage.vfs.testing import MutationFixture, check_mutation_contract
from mirage.workspace import Workspace
from mirage.workspace.record.sql import SqlRecordClient
from mirage.workspace.store.sql import SqlWorkspaceStateStore
from tests.fixtures.postgres import ON_POSTGRES, fresh_database

SCRATCH = MutationFixture(
    PathSpec(virtual="/sql/scratch", directory="/sql", vfs_path="scratch")
)
CS = DEFAULT_CHUNK_SIZE


def at(p: str) -> PathSpec:
    return PathSpec.from_str_path(p)


async def whole(vfs: SqlVFS, p: str) -> bytes:
    return await materialize(await vfs.read(at(p)))


def racing(vfs: SqlVFS, sql: list[str]) -> None:
    """A writer racing the next op: ``sql`` lands just before the op's
    own batch, after its lookups."""
    driver = vfs.accessor.driver
    batch = driver.batch
    pending = [True]

    def landing(statements: Sequence[SqlStatement]) -> None:
        if pending:
            pending.clear()
            batch([SqlStatement(s) for s in sql])
        batch(statements)

    driver.batch = landing  # type: ignore[method-assign]


# D1 and Durable Objects run SQLite with these limits lowered to 100.
WORKERD_LIMITS = (
    sqlite3.SQLITE_LIMIT_COLUMN,
    sqlite3.SQLITE_LIMIT_EXPR_DEPTH,
    sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,
)


# A Postgres database again, the suite's mount on a folder of it.
ON_POSTGRES_FOLDER = pytest.param("postgres_folder", marks=ON_POSTGRES.marks)


@pytest_asyncio.fixture(
    params=[
        "sqlite",
        "workerd_limits",
        "folder",
        ON_POSTGRES,
        ON_POSTGRES_FOLDER,
    ]
)
async def vfs(request: pytest.FixtureRequest) -> AsyncIterator[SqlVFS]:
    database = contextlib.ExitStack()
    driver: SqlDriver
    if request.param.startswith("postgres"):
        driver = PostgresSqlDriver(database.enter_context(fresh_database()))
    else:
        sqlite = SqliteDriver()
        if request.param == "workerd_limits":
            db = sqlite._open()
            for limit in WORKERD_LIMITS:
                db.setlimit(limit, 100)
        driver = sqlite
    root = "/"
    if request.param.endswith("folder"):
        # A file beside the folder, which the suite's mount never sees.
        await SqlVFS(driver=driver).write(at("/beside"), b"kept")
        root = "/a/b"
    v = SqlVFS(driver=driver, root=root)
    yield v
    await v.close()
    driver.close()
    database.close()


@pytest.mark.asyncio
async def test_it_passes_the_mutation_contract(vfs: SqlVFS):
    await vfs.mkdir(at("/scratch"))
    await check_mutation_contract(vfs, SCRATCH)


@pytest.mark.asyncio
async def test_a_file_across_chunk_boundaries_reads_whole_and_in_windows(
    vfs: SqlVFS,
):
    data = bytes(i % 251 for i in range(CS * 2 + 5))
    rows = await vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_data")
    before = rows[0]["n"]
    await vfs.write(at("/big"), data)
    assert (await vfs.stat(at("/big"))).size == len(data)
    assert await whole(vfs, "/big") == data
    assert await vfs.read(at("/big"), CS - 2, 6) == data[CS - 2 : CS + 4]
    assert await vfs.read(at("/big"), CS * 2, None) == data[CS * 2 :]
    rows = await vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_data")
    assert rows[0]["n"] - before == 3


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
    count = "SELECT COUNT(*) AS n FROM fs_inode"
    before = (await vfs.accessor.query(count))[0]["n"]
    await vfs.mkdir(at("/a/b"), parents=True)
    await vfs.write(at("/a/b/f"), b"hi")
    await vfs.rename(at("/a"), at("/z"))
    assert await whole(vfs, "/z/b/f") == b"hi"
    assert not await vfs.exists(at("/a"))
    with pytest.raises(OSError):
        await vfs.rename(at("/z"), at("/z/b/in"))
    await vfs.rm_r(at("/z"))
    assert await vfs.readdir(at("/")) == []
    assert (await vfs.accessor.query(count))[0]["n"] == before


@pytest.mark.asyncio
async def test_copy_stays_inside_the_database(vfs: SqlVFS):
    await vfs.write(at("/src"), b"copied")
    await vfs.copy(at("/src"), at("/dst"))
    assert await whole(vfs, "/dst") == b"copied"
    assert await whole(vfs, "/src") == b"copied"


@pytest.mark.asyncio
async def test_a_path_deeper_than_one_query_joins_still_walks(vfs: SqlVFS):
    deep = "/" + "/".join(f"d{i}" for i in range(40))
    await vfs.mkdir(at(deep), parents=True)
    await vfs.write(at(f"{deep}/f"), b"deep")
    assert await whole(vfs, f"{deep}/f") == b"deep"
    assert (await vfs.stat(at(deep))).type == FileType.DIRECTORY
    assert not await vfs.exists(at(f"{deep}/nope/f"))


@pytest.mark.asyncio
@pytest.mark.parametrize("depth", [19, 20, 31, 32, 96])
async def test_it_makes_writes_reads_moves_copies_and_removes_deep(
    vfs: SqlVFS, depth: int
):
    d = "/" + "/".join(f"d{i}" for i in range(depth - 1))
    await vfs.mkdir(at(f"{d}/g"), parents=True)
    await vfs.write(at(f"{d}/f"), b"deep")
    assert await whole(vfs, f"{d}/f") == b"deep"
    assert (await vfs.stat(at(f"{d}/g"))).type == FileType.DIRECTORY
    await vfs.rename(at(f"{d}/f"), at(f"{d}/h"))
    assert await whole(vfs, f"{d}/h") == b"deep"
    await vfs.copy(at(f"{d}/h"), at(f"{d}/c"))
    assert await whole(vfs, f"{d}/c") == b"deep"
    await vfs.unlink(at(f"{d}/h"))
    assert not await vfs.exists(at(f"{d}/h"))
    assert [e.name for e in await vfs.readdir(at(d))] == ["c", "g"]
    await vfs.rm_r(at("/d0"))
    assert await vfs.readdir(at("/")) == []


@pytest.mark.asyncio
async def test_a_move_onto_a_directory_written_into_since_its_check_fails(
    vfs: SqlVFS,
):
    top = vfs.accessor.root_ino()
    await vfs.mkdir(at("/src"))
    await vfs.mkdir(at("/dst"))
    racing(
        vfs,
        [
            "INSERT INTO fs_inode (ino, mode, size, mtime)"
            f" VALUES (1000, {FILE}, 0, 0)",
            "INSERT INTO fs_dentry (name, parent_ino, ino) SELECT 'new',"
            f" ino, 1000 FROM fs_dentry WHERE parent_ino = {top} AND name = 'dst'",
        ],
    )
    with pytest.raises(OSError) as raised:
        await vfs.rename(at("/src"), at("/dst"))
    assert raised.value.errno == errno.ENOTEMPTY
    assert await vfs.exists(at("/dst/new"))
    assert await vfs.exists(at("/src"))


@pytest.mark.asyncio
async def test_a_write_whose_directory_went_since_its_lookup_strands_nothing(
    vfs: SqlVFS,
):
    top = vfs.accessor.root_ino()
    await vfs.mkdir(at("/d"))
    racing(
        vfs,
        [
            "DELETE FROM fs_inode WHERE ino IN (SELECT ino FROM fs_dentry"
            f" WHERE parent_ino = {top} AND name = 'd')",
            f"DELETE FROM fs_dentry WHERE parent_ino = {top} AND name = 'd'",
        ],
    )
    with pytest.raises(Exception):
        await vfs.write(at("/d/f"), b"x")
    rows = await vfs.accessor.query(
        f"SELECT ino FROM fs_inode WHERE ino > {top}"
    )
    assert rows == []


@pytest.mark.asyncio
async def test_an_append_raced_by_another_lands_at_the_end_it_left(
    vfs: SqlVFS,
):
    top = vfs.accessor.root_ino()
    await vfs.write(at("/f"), b"a")
    named = (
        f"(SELECT ino FROM fs_dentry WHERE parent_ino = {top} AND name = 'f')"
    )
    ab = (
        "'\\x6162'::bytea"
        if vfs.accessor.driver.dialect == SqlDialect.POSTGRES
        else "X'6162'"
    )
    racing(
        vfs,
        [
            f"UPDATE fs_data SET data = {ab} WHERE ino = {named}",
            f"UPDATE fs_inode SET size = 2, mtime = mtime + 1 WHERE ino = {named}",
        ],
    )
    await vfs.append(at("/f"), b"c")
    assert await whole(vfs, "/f") == b"abc"


@pytest.mark.asyncio
async def test_a_file_moved_while_its_old_name_is_unlinked_is_kept(
    vfs: SqlVFS,
):
    top = vfs.accessor.root_ino()
    await vfs.write(at("/a"), b"kept")
    racing(
        vfs,
        [
            "UPDATE fs_dentry SET name = 'b'"
            f" WHERE parent_ino = {top} AND name = 'a'"
        ],
    )
    await vfs.unlink(at("/a"))
    assert await whole(vfs, "/b") == b"kept"


@pytest.mark.asyncio
async def test_an_append_retries_on_its_own_file_not_its_old_path(
    vfs: SqlVFS,
):
    top = vfs.accessor.root_ino()
    await vfs.write(at("/f"), b"a")
    named = (
        f"(SELECT ino FROM fs_dentry WHERE parent_ino = {top} AND name = 'g')"
    )
    racing(
        vfs,
        [
            "UPDATE fs_dentry SET name = 'g'"
            f" WHERE parent_ino = {top} AND name = 'f'",
            f"UPDATE fs_inode SET mtime = mtime + 1 WHERE ino = {named}",
            "INSERT INTO fs_inode (ino, mode, size, mtime)"
            f" VALUES (1000, {DIR}, 0, 0)",
            "INSERT INTO fs_dentry (name, parent_ino, ino)"
            f" VALUES ('f', {top}, 1000)",
        ],
    )
    await vfs.append(at("/f"), b"c")
    assert await whole(vfs, "/g") == b"ac"
    assert (await vfs.stat(at("/f"))).type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_a_restore_takes_fresh_inode_numbers(vfs: SqlVFS):
    deep = "/" + "/".join(f"d{i}" for i in range(40))
    await vfs.mkdir(at(deep), parents=True)
    await vfs.write(at(f"{deep}/f"), b"x")

    top = vfs.accessor.root_ino()

    async def inos() -> list[int]:
        rows = await vfs.accessor.query(
            f"SELECT ino FROM fs_inode WHERE ino > {top}"
        )
        return [int(r["ino"] or 0) for r in rows]

    before = max(await inos())
    vfs.load_state(vfs.get_state())
    assert min(await inos()) > before
    assert await whole(vfs, f"{deep}/f") == b"x"
    await vfs.write(at("/later"), b"y")
    assert await whole(vfs, "/later") == b"y"


@pytest.mark.asyncio
async def test_it_keeps_no_attributes_so_the_namespace_keeps_them(
    vfs: SqlVFS,
):
    assert not vfs.supports("setattr")


@pytest.mark.asyncio
async def test_its_tables_hold_the_tree_and_the_bytes_alone():
    driver = SqliteDriver()
    vfs = SqlVFS(driver=driver)
    try:
        await vfs.mkdir(at("/d"))
        await vfs.write(at("/d/f"), b"hi")
        tables = driver.query(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
            " AND name LIKE 'fs_%' ORDER BY name"
        )
        assert [t["name"] for t in tables] == [
            "fs_config",
            "fs_data",
            "fs_dentry",
            "fs_inode",
        ]
        assert driver.query("SELECT key, value FROM fs_config") == [
            {"key": "chunk_size", "value": str(CS)}
        ]
        tree = driver.query(
            "SELECT d.name, i.mode, i.size FROM fs_dentry d"
            " JOIN fs_inode i ON i.ino = d.ino ORDER BY d.name"
        )
        assert tree == [
            {"name": "d", "mode": DIR, "size": 0},
            {"name": "f", "mode": FILE, "size": 2},
        ]
    finally:
        await vfs.close()
        driver.close()


@pytest.mark.asyncio
async def test_chmod_lands_in_the_namespace_not_the_tables():
    driver = SqliteDriver()
    ws = Workspace({"/w": SqlVFS(driver=driver)}, mode=MountMode.WRITE)
    try:
        r = await ws.shell("touch /w/f && chmod 600 /w/f && stat -c %a /w/f")
        assert await r.stdout_str() == "600\n"
        assert driver.query("SELECT mode FROM fs_inode WHERE ino > 1") == [
            {"mode": FILE}
        ]
    finally:
        await ws.close()
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
        r = await ws.shell("mkdir -p /w/d && printf hi > /w/d/f")
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
        assert (await copy.stat(at("/d"))).type == FileType.DIRECTORY
    finally:
        await copy.close()


@pytest.mark.asyncio
async def test_an_uncapped_database_grows(vfs: SqlVFS):
    assert (await vfs.capacity()).state == CapacityState.ELASTIC
    folder = "" if vfs.accessor.root == "/" else vfs.accessor.root
    assert vfs.storage_location() == (
        f"sql:{vfs.accessor.driver.location}{folder}"
    )


def test_two_memory_databases_differ_and_two_names_of_one_file_agree(
    tmp_path,
):
    assert SqlVFS().storage_location() != SqlVFS().storage_location()
    path = tmp_path / "fs.db"
    assert (
        SqlVFS(str(path)).storage_location()
        == SqlVFS(f"{tmp_path}/./fs.db").storage_location()
    )


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


async def names(vfs: SqlVFS) -> list[str]:
    return [e.name for e in await vfs.readdir(at("/"))]


@pytest.mark.asyncio
async def test_a_folder_of_the_database_is_made_and_the_whole_shows_it():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    folder = SqlVFS(driver=driver, root="/workspace/")
    await folder.write(at("/a.txt"), b"hi")
    assert await names(folder) == ["a.txt"]
    assert await names(whole_db) == ["workspace"]
    assert await whole(whole_db, "/workspace/a.txt") == b"hi"
    assert folder.storage_location() == (
        f"{whole_db.storage_location()}/workspace"
    )
    driver.close()


@pytest.mark.asyncio
async def test_a_gone_folder_is_made_again_and_a_file_at_it_refused():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    await whole_db.write(at("/f"), b"x")
    with pytest.raises(NotADirectoryError):
        await SqlVFS(driver=driver, root="/f").readdir(at("/"))
    folder = SqlVFS(driver=driver, root="/d")
    await folder.write(at("/a"), b"x")
    await whole_db.rm_r(at("/d"))
    assert await names(folder) == []
    assert folder.get_state()["files"] == {}
    await folder.write(at("/b"), b"y")
    assert await whole(whole_db, "/d/b") == b"y"
    driver.close()


@pytest.mark.asyncio
async def test_a_file_at_the_folder_is_no_directory_nor_written_beside():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    folder = SqlVFS(driver=driver, root="/d")
    await folder.write(at("/a"), b"x")
    await whole_db.rm_r(at("/d"))
    await whole_db.write(at("/d"), b"file")
    with pytest.raises(NotADirectoryError):
        await folder.stat(at("/"))
    with pytest.raises(NotADirectoryError):
        await folder.mkdir(at("/"))
    with pytest.raises(NotADirectoryError):
        await folder.mkdir(at("/x/y"), parents=True)
    with pytest.raises(NotADirectoryError):
        await folder.write(at("/"), b"z")
    assert driver.query("SELECT name FROM fs_dentry WHERE name = ''") == []
    under = driver.query(
        "SELECT name FROM fs_dentry WHERE parent_ino ="
        " (SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'd')"
    )
    assert under == []
    driver.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("first", ["whole", "folder"])
async def test_both_snapshots_restore_in_either_order(first: str):
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    folder = SqlVFS(driver=driver, root="/w")
    await whole_db.write(at("/keep"), b"k")
    # The whole database's snapshot comes first, before the folder's
    # first op made the folder.
    whole_state = whole_db.get_state()
    own = folder.get_state()
    await folder.write(at("/later"), b"l")
    if first == "folder":
        folder.load_state(own)
    whole_db.load_state(whole_state)
    if first == "whole":
        folder.load_state(own)
    assert await names(folder) == []
    assert await whole(whole_db, "/keep") == b"k"
    driver.close()


@pytest.mark.asyncio
async def test_a_restore_whose_folder_went_before_its_batch_strands_nothing():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    folder = SqlVFS(driver=driver, root="/d")
    await folder.write(at("/a"), b"x")
    state = folder.get_state()
    top = folder.accessor.root_ino()
    racing(
        folder,
        [
            *clear_under(top),
            "DELETE FROM fs_dentry WHERE parent_ino = 1 AND name = 'd'",
            f"DELETE FROM fs_inode WHERE ino = {top}",
        ],
    )
    with pytest.raises(Exception):
        folder.load_state(state)
    assert await names(whole_db) == []
    assert driver.query("SELECT COUNT(*) AS n FROM fs_inode")[0]["n"] == 1
    driver.close()


@pytest.mark.asyncio
async def test_two_writes_on_one_file_through_two_mounts_overlap():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver, capacity=100)
    folder = SqlVFS(driver=driver, root="/w", capacity=100)
    usage = whole_db.usage
    assert usage is not None
    await whole_db.mkdir(at("/w"))
    gate = asyncio.Event()

    async def slow() -> AsyncIterator[bytes]:
        yield b"ab"
        await gate.wait()
        yield b"cd"

    first = asyncio.create_task(folder.write(at("/f"), slow()))
    while len(usage.active) < 1:
        await asyncio.sleep(0.01)
    # The second lands while the first is open, and marks the count for
    # a recount, as two writes on one file through one mount do.
    assert not usage.dirty
    await whole_db.write(at("/w/f"), b"xyz")
    assert usage.dirty
    gate.set()
    await first
    driver.close()


@pytest.mark.asyncio
async def test_mounts_on_one_driver_count_against_one_capacity():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver, capacity=10)
    folder = SqlVFS(driver=driver, root="/w", capacity=10)
    assert folder.usage is whole_db.usage
    assert SqlVFS(driver=driver, capacity=20).usage is not whole_db.usage
    assert SqlVFS(capacity=10).usage is not whole_db.usage
    await whole_db.write(at("/x"), b"123456")
    with pytest.raises(OSError) as raised:
        await folder.write(at("/y"), b"123456")
    assert raised.value.errno == errno.EDQUOT
    await folder.write(at("/y"), b"1234")
    assert await folder.capacity() == await whole_db.capacity()
    report = await whole_db.capacity()
    assert (report.used, report.available) == (10, 0)
    driver.close()


@pytest.mark.asyncio
async def test_a_folder_snapshots_and_restores_alone():
    driver = SqliteDriver()
    whole_db = SqlVFS(driver=driver)
    folder = SqlVFS(driver=driver, root="/w")
    await whole_db.write(at("/keep"), b"k")
    await folder.mkdir(at("/d"))
    await folder.write(at("/d/a"), b"a")
    state = folder.get_state()
    assert list(state["files"]) == ["/d/a"]
    assert state["dirs"] == ["/", "/d"]
    await folder.write(at("/b"), b"b")
    await folder.rm_r(at("/d"))
    folder.load_state(state)
    assert await names(folder) == ["d"]
    assert await whole(folder, "/d/a") == b"a"
    assert await names(whole_db) == ["keep", "w"]
    assert await whole(whole_db, "/keep") == b"k"
    # Every inode but the root has one entry naming it: the restore
    # stranded none, its own counting inode included.
    inodes = driver.query("SELECT COUNT(*) AS n FROM fs_inode")[0]["n"]
    entries = driver.query("SELECT COUNT(*) AS n FROM fs_dentry")[0]["n"]
    assert inodes == entries + 1
    driver.close()


@pytest.mark.asyncio
async def test_the_shell_gets_root_and_workspace_on_one_database():
    driver = SqliteDriver()
    ws = Workspace(
        {
            "/": SqlVFS(driver=driver, capacity=1000),
            "/workspace": SqlVFS(
                driver=driver, root="/workspace", capacity=1000
            ),
        },
        mode=MountMode.WRITE,
    )
    try:
        r = await ws.shell(
            "printf hi > /workspace/a.txt && printf yo > /b.txt"
            " && ls /workspace && cat /workspace/a.txt && du -s /workspace"
        )
        assert await r.stderr_str() == ""
        assert await r.stdout_str() == "a.txt\nhi2\t/workspace\n"
        assert await whole(SqlVFS(driver=driver), "/workspace/a.txt") == b"hi"
    finally:
        await ws.close()
        driver.close()
