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

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from mirage import MountMode, Workspace
from mirage.cache.index import LookupStatus
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
from tests.fixtures.databricks_api import FakeFiles
from tests.fixtures.driver_ops import ops
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import served


def make_vfs(files: FakeFiles) -> DatabricksVolumeVFS:
    return DatabricksVolumeVFS(
        DatabricksVolumeConfig(
            catalog="main",
            schema="default",
            volume="agent_files",
            root_path="/root",
            host=files.host,
            token="secret",
        )
    )


def seed_directory(files: FakeFiles, path: str) -> None:
    files.directory_metadata.add(path)
    files.metadata[path] = SimpleNamespace(is_directory=True)
    files.directories.setdefault(path, [])


def seed_file(files: FakeFiles, path: str, data: bytes) -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = SimpleNamespace(
        content_length=len(data),
        content_type=None,
        last_modified=None,
    )
    files.directories.setdefault(parent, [])
    files.directories[parent].append(
        SimpleNamespace(
            path=path,
            is_directory=False,
            file_size=len(data),
        )
    )


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
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        host="https://dbc.example.com",
        token="secret",
    )
    path = PathSpec(
        vfs_path=mount_key("/volume/reports/latest.md", "/volume"),
        virtual="/volume/reports/latest.md",
        directory="/volume/reports",
    )
    assert backend_path(config, path) == (
        "/Volumes/main/default/agent_files/root/reports/latest.md"
    )


def test_vfs_state_redacts_token():
    vfs = make_vfs(FakeFiles())
    state = vfs.get_state()
    assert state["type"] == VFSName.DATABRICKS_VOLUME
    assert state["needs_override"] is True
    assert state["config"]["token"] == "<REDACTED>"
    assert state["config"]["host"] == vfs.config.host
    assert state["config"]["catalog"] == "main"
    assert "redacted_fields" not in state


def test_vfs_registers_ops():
    vfs = make_vfs(FakeFiles())
    op_names = served(vfs)
    assert {"read", "readdir", "stat", "write", "create", "unlink"} <= op_names
    assert vfs.name == "databricks_volume"
    assert vfs.caches_reads is True


def test_vfs_registers_commands():
    vfs = make_vfs(FakeFiles())
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
async def test_read_stat_readdir_range_stream_and_exists():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/reports/latest.md"] = b"abcdef"
    files.metadata[f"{root}/reports/latest.md"] = SimpleNamespace(
        content_length=6,
        content_type=None,
        last_modified="Tue, 14 Nov 2023 22:13:20 GMT",
    )
    files.metadata[f"{root}/reports"] = SimpleNamespace(is_directory=True)
    files.directories[f"{root}/reports"] = [
        SimpleNamespace(
            path=f"{root}/reports/latest.md",
            is_directory=False,
            file_size=6,
        )
    ]
    vfs = make_vfs(files)

    assert (
        await read(
            vfs.accessor,
            PathSpec.from_str_path(
                "/volume/reports/latest.md",
                mount_key("/volume/reports/latest.md", "/volume"),
            ),
        )
        == b"abcdef"
    )
    assert (
        await read(
            vfs.accessor,
            PathSpec.from_str_path(
                "/volume/reports/latest.md",
                mount_key("/volume/reports/latest.md", "/volume"),
            ),
            offset=1,
            size=3,
        )
        == b"bcd"
    )
    chunks = [
        chunk
        async for chunk in read_stream(
            vfs.accessor,
            PathSpec.from_str_path(
                "/volume/reports/latest.md",
                mount_key("/volume/reports/latest.md", "/volume"),
            ),
            chunk_size=2,
        )
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    file_stat = await ops(vfs).stat(
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume"),
        )
    )
    assert file_stat.name == "latest.md"
    assert file_stat.size == 6
    assert file_stat.modified == "2023-11-14T22:13:20Z"
    assert await exists(
        vfs.accessor,
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume"),
        ),
    )
    assert not await exists(
        vfs.accessor,
        PathSpec.from_str_path(
            "/volume/missing.md", mount_key("/volume/missing.md", "/volume")
        ),
    )
    entries = await ops(vfs).readdir(
        PathSpec.from_str_path(
            "/volume/reports", mount_key("/volume/reports", "/volume")
        )
    )
    assert [row.name for row in entries] == ["latest.md"]


@pytest.mark.asyncio
async def test_workspace_read_mode_uses_registered_ops():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/latest.md"] = b"hello"
    files.metadata[f"{root}/latest.md"] = SimpleNamespace(
        content_length=5,
        content_type=None,
        last_modified=None,
    )
    ws = Workspace({"/volume": make_vfs(files)}, mode=MountMode.READ)

    assert await ws.vfs.read("/volume/latest.md") == b"hello"
    file_stat = await ws.vfs.stat("/volume/latest.md")
    assert file_stat.size == 5


@pytest.mark.asyncio
async def test_vfs_exposes_file_write_ops():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    vfs = make_vfs(files)

    await ops(vfs).write(
        PathSpec.from_str_path(
            "/volume/new.txt", mount_key("/volume/new.txt", "/volume")
        ),
        b"hello",
    )
    await ops(vfs).create(
        PathSpec.from_str_path(
            "/volume/empty.txt", mount_key("/volume/empty.txt", "/volume")
        )
    )
    await ops(vfs).unlink(
        PathSpec.from_str_path(
            "/volume/new.txt", mount_key("/volume/new.txt", "/volume")
        )
    )

    assert files.downloads[f"{root}/empty.txt"] == b""
    assert f"{root}/new.txt" not in files.downloads


@pytest.mark.asyncio
async def test_workspace_write_mode_uses_file_write_ops():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)

    await ws.vfs.write("/dbx/new.txt", b"hello")
    await ws.vfs.create("/dbx/empty.txt")
    await ws.vfs.unlink("/dbx/new.txt")

    assert f"{root}/new.txt" not in files.downloads
    assert files.downloads[f"{root}/empty.txt"] == b""


@pytest.mark.asyncio
async def test_workspace_write_mode_invalidates_parent_directory_index():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)
    index = ws.mount("/dbx/").index_store

    await index.set_dir(
        "/dbx",
        [
            (
                "old.txt",
                FileStat(
                    name="old.txt",
                    type=FileType.FILE,
                    fingerprint="/dbx/old.txt",
                ),
            )
        ],
    )
    assert (await index.list_dir("/dbx")).entries == ["/dbx/old.txt"]

    await ws.vfs.write("/dbx/new.txt", b"hello")
    assert (await index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)

    await index.set_dir(
        "/dbx",
        [
            (
                "new.txt",
                FileStat(
                    name="new.txt",
                    type=FileType.FILE,
                    fingerprint="/dbx/new.txt",
                ),
            )
        ],
    )
    await ws.vfs.create("/dbx/empty.txt")
    assert (await index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)

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
    assert (await index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_ops():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

    with pytest.raises(PermissionError):
        await ws.vfs.write("/dbx/new.txt", b"hello")
    with pytest.raises(PermissionError):
        await ws.vfs.create("/dbx/empty.txt")
    with pytest.raises(PermissionError):
        await ws.vfs.unlink("/dbx/new.txt")


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_and_rm():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)

    touch_io = await ws.shell("touch /dbx/created.txt")
    rm_io = await ws.shell("rm /dbx/created.txt")

    assert touch_io.exit_code == 0
    assert files.delete_calls == [f"{root}/created.txt"]
    assert f"{root}/created.txt" not in files.downloads
    assert rm_io.exit_code == 0


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_resolves_glob():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_file(files, f"{root}/one.txt", b"one")
    seed_file(files, f"{root}/two.txt", b"two")
    seed_file(files, f"{root}/keep.md", b"keep")
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)

    io = await ws.shell("rm /dbx/*.txt")

    assert io.exit_code == 0
    assert files.delete_calls == [f"{root}/one.txt", f"{root}/two.txt"]
    assert f"{root}/one.txt" not in files.downloads
    assert f"{root}/two.txt" not in files.downloads
    assert files.downloads[f"{root}/keep.md"] == b"keep"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_resolves_glob():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_file(files, f"{root}/existing.txt", b"existing")
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)

    io = await ws.shell("touch /dbx/*.txt")

    assert io.exit_code == 0
    assert files.upload_calls == []
    assert f"{root}/*.txt" not in files.downloads


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_rejects_directory():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_directory(files, f"{root}/dir")
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.WRITE)

    io = await ws.shell("rm /dbx/dir")

    assert io.exit_code == 1
    assert b"IsADirectoryError" in io.stderr or b"Is a directory" in io.stderr


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_commands():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

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
async def test_workspace_execute_uses_databricks_volume_mount_for_ls():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.add(root)
    files.metadata[f"{root}/debug_output.json"] = SimpleNamespace(
        content_length=18,
        content_type=None,
        last_modified=None,
    )
    files.directories[root] = [
        SimpleNamespace(
            path=f"{root}/debug_output.json",
            is_directory=False,
            file_size=18,
        )
    ]
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

    io = await ws.shell("ls /dbx")
    slash_io = await ws.shell("ls /dbx/")

    assert io.exit_code == 0
    assert b"debug_output.json" in io.stdout
    assert slash_io.exit_code == 0
    assert b"debug_output.json" in slash_io.stdout
    mount = await ws._registry.resolve_mount(
        "ls",
        [PathSpec.from_str_path("/dbx", mount_key("/dbx", "/dbx"))],
        "/",
    )
    assert mount is not None
    assert mount.prefix == "/dbx/"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_stat_and_cat():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/debug_output.json"] = b'{"ok": true}\nsecond\n'
    files.metadata[f"{root}/debug_output.json"] = SimpleNamespace(
        content_length=20,
        content_type=None,
        last_modified=None,
    )
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

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
async def test_workspace_execute_databricks_volume_find_files():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.update({root, f"{root}/nested"})
    files.metadata[f"{root}/nested"] = SimpleNamespace(is_directory=True)
    files.metadata[f"{root}/debug_output.json"] = SimpleNamespace(
        content_length=2,
        content_type=None,
        last_modified=None,
    )
    files.metadata[f"{root}/nested/result.txt"] = SimpleNamespace(
        content_length=2,
        content_type=None,
        last_modified=None,
    )
    files.directories[root] = [
        SimpleNamespace(
            path=f"{root}/debug_output.json",
            is_directory=False,
            file_size=2,
        ),
        SimpleNamespace(path=f"{root}/nested", is_directory=True),
    ]
    files.directories[f"{root}/nested"] = [
        SimpleNamespace(
            path=f"{root}/nested/result.txt",
            is_directory=False,
            file_size=2,
        )
    ]
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

    io = await ws.shell("find /dbx -maxdepth 2 -type f")

    assert io.exit_code == 0
    assert b"/dbx/debug_output.json" in io.stdout
    assert b"/dbx/nested/result.txt" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_recursive_grep_and_rg():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.update(
        {
            root,
            f"{root}/nested",
            f"{root}/nested/deeper",
        }
    )
    files.metadata[f"{root}/nested"] = SimpleNamespace(is_directory=True)
    files.metadata[f"{root}/nested/deeper"] = SimpleNamespace(
        is_directory=True
    )
    files.metadata[f"{root}/nested/info.txt"] = SimpleNamespace(
        content_length=17,
        content_type=None,
        last_modified=None,
    )
    files.metadata[f"{root}/nested/deeper/notes.md"] = SimpleNamespace(
        content_length=26,
        content_type=None,
        last_modified=None,
    )
    files.downloads[f"{root}/nested/info.txt"] = b"alpha debug line\n"
    files.downloads[f"{root}/nested/deeper/notes.md"] = (
        b"# Notes\nbeta debug detail\n"
    )
    files.directories[root] = [
        SimpleNamespace(path=f"{root}/nested", is_directory=True),
    ]
    files.directories[f"{root}/nested"] = [
        SimpleNamespace(
            path=f"{root}/nested/info.txt",
            is_directory=False,
            file_size=17,
        ),
        SimpleNamespace(path=f"{root}/nested/deeper", is_directory=True),
    ]
    files.directories[f"{root}/nested/deeper"] = [
        SimpleNamespace(
            path=f"{root}/nested/deeper/notes.md",
            is_directory=False,
            file_size=26,
        )
    ]
    ws = Workspace({"/dbx/": make_vfs(files)}, mode=MountMode.READ)

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
