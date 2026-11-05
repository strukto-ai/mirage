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

import errno
import sqlite3
from collections.abc import AsyncIterator, Sequence

import pytest
import pytest_asyncio

from mirage.core.sql.constants import DEFAULT_CHUNK_SIZE, DIR, FILE
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


@pytest_asyncio.fixture(params=["sqlite", "workerd_limits"])
async def vfs(request: pytest.FixtureRequest) -> AsyncIterator[SqlVFS]:
    driver = SqliteDriver()
    if request.param == "workerd_limits":
        db = driver._open()
        for limit in WORKERD_LIMITS:
            db.setlimit(limit, 100)
    v = SqlVFS(driver=driver)
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
    rows = await vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_data")
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
    rows = await vfs.accessor.query("SELECT COUNT(*) AS n FROM fs_inode")
    assert rows[0]["n"] == 1


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
    await vfs.mkdir(at("/src"))
    await vfs.mkdir(at("/dst"))
    racing(
        vfs,
        [
            "INSERT INTO fs_inode (ino, mode, size, mtime)"
            f" VALUES (1000, {FILE}, 0, 0)",
            "INSERT INTO fs_dentry (name, parent_ino, ino) SELECT 'new',"
            " ino, 1000 FROM fs_dentry WHERE parent_ino = 1 AND name = 'dst'",
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
    await vfs.mkdir(at("/d"))
    racing(
        vfs,
        [
            "DELETE FROM fs_inode WHERE ino IN (SELECT ino FROM fs_dentry"
            " WHERE parent_ino = 1 AND name = 'd')",
            "DELETE FROM fs_dentry WHERE parent_ino = 1 AND name = 'd'",
        ],
    )
    with pytest.raises(Exception):
        await vfs.write(at("/d/f"), b"x")
    rows = await vfs.accessor.query("SELECT ino FROM fs_inode")
    assert [r["ino"] for r in rows] == [1]


@pytest.mark.asyncio
async def test_an_append_raced_by_another_lands_at_the_end_it_left(
    vfs: SqlVFS,
):
    await vfs.write(at("/f"), b"a")
    named = "(SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'f')"
    racing(
        vfs,
        [
            f"UPDATE fs_data SET data = X'6162' WHERE ino = {named}",
            f"UPDATE fs_inode SET size = 2, mtime = mtime + 1 WHERE ino = {named}",
        ],
    )
    await vfs.append(at("/f"), b"c")
    assert await whole(vfs, "/f") == b"abc"


@pytest.mark.asyncio
async def test_a_file_moved_while_its_old_name_is_unlinked_is_kept(
    vfs: SqlVFS,
):
    await vfs.write(at("/a"), b"kept")
    racing(
        vfs,
        [
            "UPDATE fs_dentry SET name = 'b' WHERE parent_ino = 1 AND name = 'a'"
        ],
    )
    await vfs.unlink(at("/a"))
    assert await whole(vfs, "/b") == b"kept"


@pytest.mark.asyncio
async def test_an_append_retries_on_its_own_file_not_its_old_path(
    vfs: SqlVFS,
):
    await vfs.write(at("/f"), b"a")
    named = "(SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'g')"
    racing(
        vfs,
        [
            "UPDATE fs_dentry SET name = 'g' WHERE parent_ino = 1 AND name = 'f'",
            f"UPDATE fs_inode SET mtime = mtime + 1 WHERE ino = {named}",
            "INSERT INTO fs_inode (ino, mode, size, mtime)"
            f" VALUES (1000, {DIR}, 0, 0)",
            "INSERT INTO fs_dentry (name, parent_ino, ino)"
            " VALUES ('f', 1, 1000)",
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

    async def inos() -> list[int]:
        rows = await vfs.accessor.query(
            "SELECT ino FROM fs_inode WHERE ino > 1"
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
    assert vfs.storage_location().startswith("sql::memory:#")


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
