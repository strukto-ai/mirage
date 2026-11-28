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

from email.utils import parsedate_to_datetime

import pytest
from pydantic import ValidationError

from mirage import MountMode, Workspace
from mirage.core.databricks_volume.exists import exists
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.read import read
from mirage.core.databricks_volume.stream import read_stream
from mirage.types import FileStat, FileType, PathSpec, VFSName
from mirage.utils.key_prefix import mount_key
from mirage.vfs.databricks_volume import (
    DatabricksVolumeConfig,
    DatabricksVolumeVFS,
)
from tests.fixtures.databricks_volume import FILES, ROOT, DatabricksVolume
from tests.fixtures.driver_ops import ops
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import served

OFFLINE = DatabricksVolumeConfig(
    catalog="main",
    schema="default",
    volume="agent_files",
    root_path="/root",
    host="https://dbc.example.com",
    token="secret",
)


def make_vfs(volume: DatabricksVolume) -> DatabricksVolumeVFS:
    return DatabricksVolumeVFS(volume.config())


def spec(virtual: str, prefix: str = "/volume") -> PathSpec:
    return PathSpec.from_str_path(virtual, mount_key(virtual, prefix))


def test_config_validation_and_normalization():
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="nested/path",
        host="https://dbc.example.com",
        token="secret",
    )
    assert config.root_path == "/nested/path"
    with pytest.raises(ValidationError):
        DatabricksVolumeConfig(
            catalog="main/other",
            schema="default",
            volume="agent_files",
        )


def test_backend_path_uses_volume_root_and_strips_mount_prefix():
    path = PathSpec(
        vfs_path=mount_key("/volume/reports/latest.md", "/volume"),
        virtual="/volume/reports/latest.md",
        directory="/volume/reports",
    )
    assert backend_path(OFFLINE, path) == (
        "/Volumes/main/default/agent_files/root/reports/latest.md"
    )


def test_vfs_state_redacts_token():
    vfs = DatabricksVolumeVFS(OFFLINE)
    state = vfs.get_state()
    assert state["type"] == VFSName.DATABRICKS_VOLUME
    assert state["needs_override"] is True
    assert state["config"]["token"] == "<REDACTED>"
    assert state["config"]["host"] == vfs.config.host
    assert state["config"]["catalog"] == "main"
    assert "redacted_fields" not in state


def test_vfs_registers_ops():
    vfs = DatabricksVolumeVFS(OFFLINE)
    op_names = served(vfs)
    assert {"read", "readdir", "stat", "write", "create", "unlink"} <= op_names
    assert vfs.name == "databricks_volume"
    assert vfs.caches_reads is True


def test_vfs_registers_commands():
    vfs = DatabricksVolumeVFS(OFFLINE)
    command_names = {command.name for command in mount_commands(vfs)}
    assert {
        "cat",
        "find",
        "grep",
        "head",
        "ls",
        "rm",
        "rg",
        "stat",
        "tail",
        "touch",
        "tree",
    } <= command_names


@pytest.mark.asyncio
async def test_read_stat_readdir_range_stream_and_exists(volume):
    await volume.put(f"{ROOT}/reports/latest.md", b"abcdef")
    vfs = make_vfs(volume)
    latest = spec("/volume/reports/latest.md")

    assert await read(vfs.accessor, latest) == b"abcdef"
    assert await read(vfs.accessor, latest, offset=1, size=3) == b"bcd"
    chunks = [
        chunk
        async for chunk in read_stream(vfs.accessor, latest, chunk_size=2)
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    file_stat = await ops(vfs).stat(latest)
    assert file_stat.name == "latest.md"
    assert file_stat.size == 6
    assert file_stat.modified == parsedate_to_datetime(
        await volume.modified(f"{ROOT}/reports/latest.md")
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert await exists(vfs.accessor, latest)
    assert not await exists(vfs.accessor, spec("/volume/missing.md"))
    entries = await ops(vfs).readdir(spec("/volume/reports"))
    assert [row.name for row in entries] == ["latest.md"]


@pytest.mark.asyncio
async def test_workspace_read_mode_uses_registered_ops(volume):
    await volume.put(f"{ROOT}/latest.md", b"hello")
    ws = Workspace({"/volume": make_vfs(volume)}, mode=MountMode.READ)

    assert await ws.vfs.read("/volume/latest.md") == b"hello"
    file_stat = await ws.vfs.stat("/volume/latest.md")
    assert file_stat.size == 5


@pytest.mark.asyncio
async def test_vfs_exposes_file_write_ops(volume):
    await volume.mkdir(ROOT)
    vfs = make_vfs(volume)

    await ops(vfs).write(spec("/volume/new.txt"), b"hello")
    await ops(vfs).create(spec("/volume/empty.txt"))
    await ops(vfs).unlink(spec("/volume/new.txt"))

    assert await volume.content(f"{ROOT}/empty.txt") == b""
    assert not await volume.has(f"{ROOT}/new.txt")


@pytest.mark.asyncio
async def test_workspace_write_mode_uses_file_write_ops(volume):
    await volume.mkdir(ROOT)
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)

    await ws.vfs.write("/dbx/new.txt", b"hello")
    await ws.vfs.create("/dbx/empty.txt")
    await ws.vfs.unlink("/dbx/new.txt")

    assert not await volume.has(f"{ROOT}/new.txt")
    assert await volume.content(f"{ROOT}/empty.txt") == b""


@pytest.mark.asyncio
async def test_workspace_write_mode_preserves_sibling_index_rows(volume):
    await volume.mkdir(ROOT)
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)
    index = ws.mount("/dbx/").index_store

    old = FileStat(
        name="old.txt", type=FileType.FILE, fingerprint="/dbx/old.txt"
    )
    await index.set_dir("/dbx", [("old.txt", old)])
    assert (await index.list_dir("/dbx")).entries == ["/dbx/old.txt"]

    await ws.vfs.write("/dbx/new.txt", b"hello")
    listing = await index.list_dir("/dbx")
    assert listing.entries is None
    assert listing.partial_entries == ["/dbx/old.txt"]
    assert (await index.get("/dbx/old.txt")).entry == old

    new = FileStat(
        name="new.txt", type=FileType.FILE, fingerprint="/dbx/new.txt"
    )
    await index.set_dir("/dbx", [("new.txt", new)])
    await ws.vfs.create("/dbx/empty.txt")
    listing = await index.list_dir("/dbx")
    assert listing.entries is None
    assert listing.partial_entries == ["/dbx/new.txt"]
    assert (await index.get("/dbx/new.txt")).entry == new

    await index.set_dir(
        "/dbx",
        [
            (
                "empty.txt",
                FileStat(
                    name="empty.txt",
                    type=FileType.FILE,
                    fingerprint="/dbx/empty.txt",
                ),
            )
        ],
    )
    await ws.vfs.unlink("/dbx/empty.txt")
    listing = await index.list_dir("/dbx")
    assert listing.entries is None
    assert listing.partial_entries == []
    assert (await index.get("/dbx/empty.txt")).entry is None


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_ops(volume):
    await volume.mkdir(ROOT)
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    with pytest.raises(PermissionError):
        await ws.vfs.write("/dbx/new.txt", b"hello")
    with pytest.raises(PermissionError):
        await ws.vfs.create("/dbx/empty.txt")
    with pytest.raises(PermissionError):
        await ws.vfs.unlink("/dbx/new.txt")


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_and_rm(volume):
    await volume.mkdir(ROOT)
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)
    await volume.run.record_requests()

    touch_io = await ws.shell("touch /dbx/created.txt")
    rm_io = await ws.shell("rm /dbx/created.txt")

    assert touch_io.exit_code == 0
    assert await volume.asked("DELETE", FILES) == [f"{ROOT}/created.txt"]
    assert not await volume.has(f"{ROOT}/created.txt")
    assert rm_io.exit_code == 0


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_resolves_glob(volume):
    await volume.put(f"{ROOT}/one.txt", b"one")
    await volume.put(f"{ROOT}/two.txt", b"two")
    await volume.put(f"{ROOT}/keep.md", b"keep")
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)
    await volume.run.record_requests()

    io = await ws.shell("rm /dbx/*.txt")

    assert io.exit_code == 0
    assert await volume.asked("DELETE", FILES) == [
        f"{ROOT}/one.txt",
        f"{ROOT}/two.txt",
    ]
    assert not await volume.has(f"{ROOT}/one.txt")
    assert not await volume.has(f"{ROOT}/two.txt")
    assert await volume.content(f"{ROOT}/keep.md") == b"keep"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_resolves_glob(volume):
    await volume.put(f"{ROOT}/existing.txt", b"existing")
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)
    await volume.run.record_requests()

    io = await ws.shell("touch /dbx/*.txt")

    assert io.exit_code == 0
    assert await volume.asked("PUT", FILES) == []
    assert not await volume.has(f"{ROOT}/*.txt")


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_rejects_directory(
    volume,
):
    await volume.mkdir(f"{ROOT}/dir")
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.WRITE)

    io = await ws.shell("rm /dbx/dir")

    assert io.exit_code == 1
    assert b"IsADirectoryError" in io.stderr or b"Is a directory" in io.stderr


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_commands(volume):
    await volume.mkdir(ROOT)
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    touch_io = await ws.shell("touch /dbx/created.txt")
    rm_io = await ws.shell("rm /dbx/created.txt")

    assert touch_io.exit_code == 1
    assert touch_io.stderr == (
        b"touch: cannot touch '/dbx/created.txt': Read-only file system\n"
    )
    assert rm_io.exit_code == 1
    assert rm_io.stderr == (
        b"rm: cannot remove '/dbx/created.txt': No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_workspace_execute_uses_databricks_volume_mount_for_ls(volume):
    await volume.put(f"{ROOT}/debug_output.json", b'{"ok": true}\nsecond\n')
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    io = await ws.shell("ls /dbx")
    slash_io = await ws.shell("ls /dbx/")

    assert io.exit_code == 0
    assert b"debug_output.json" in io.stdout
    assert slash_io.exit_code == 0
    assert b"debug_output.json" in slash_io.stdout
    mount = await ws._registry.resolve_mount("ls", [spec("/dbx", "/dbx")], "/")
    assert mount is not None
    assert mount.prefix == "/dbx/"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_stat_and_cat(volume):
    await volume.put(f"{ROOT}/debug_output.json", b'{"ok": true}\nsecond\n')
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    stat_io = await ws.shell("stat /dbx/debug_output.json")
    cat_io = await ws.shell("cat /dbx/debug_output.json")
    head_io = await ws.shell("head -n 1 /dbx/debug_output.json")

    assert stat_io.exit_code == 0
    assert b"File: /dbx/debug_output.json" in stat_io.stdout
    assert cat_io.exit_code == 0
    assert b'{"ok": true}' in cat_io.stdout
    assert head_io.exit_code == 0
    assert head_io.stdout == b'{"ok": true}\n'


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_find_files(volume):
    await volume.put(f"{ROOT}/debug_output.json", b"{}")
    await volume.put(f"{ROOT}/nested/result.txt", b"ok")
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    io = await ws.shell("find /dbx -maxdepth 2 -type f")

    assert io.exit_code == 0
    assert b"/dbx/debug_output.json" in io.stdout
    assert b"/dbx/nested/result.txt" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_recursive_grep_and_rg(
    volume,
):
    await volume.put(f"{ROOT}/nested/info.txt", b"alpha debug line\n")
    await volume.put(
        f"{ROOT}/nested/deeper/notes.md", b"# Notes\nbeta debug detail\n"
    )
    ws = Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)

    grep_io = await ws.shell("grep -R -n debug /dbx/nested")
    rg_io = await ws.shell("rg debug /dbx/nested")

    assert grep_io.exit_code == 0
    assert b"/dbx/nested/info.txt:1:alpha debug line" in grep_io.stdout
    assert b"/dbx/nested/deeper/notes.md:2:beta debug detail" in (
        grep_io.stdout
    )
    assert not grep_io.stderr
    assert rg_io.exit_code == 0
    assert b"/dbx/nested/info.txt:alpha debug line" in rg_io.stdout
    assert b"/dbx/nested/deeper/notes.md:beta debug detail" in rg_io.stdout
    assert not rg_io.stderr


def _location(root: str, token: str) -> str | None:
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path=root,
        host="https://dbc.example.com",
        token=token,
    )
    return DatabricksVolumeVFS(config).storage_location()


def test_a_volume_root_is_one_store_whatever_its_token():
    assert _location("/root", "a") == _location("/root/", "b")
    assert _location("/root", "a") != _location("/other", "a")
