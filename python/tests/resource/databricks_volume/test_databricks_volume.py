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

import pytest
from pydantic import ValidationError

from mirage import MountMode, Workspace
from mirage.cache.index import IndexEntry, LookupStatus
from mirage.core.databricks_volume.client import HttpDatabricksFilesClient
from mirage.core.databricks_volume.path import backend_path
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource,
                                               StaticTokenProvider)
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key
from tests.core.databricks_volume._fakes import (CONFIG, FakeFilesClient,
                                                 directory_entry, file_entry,
                                                 file_metadata, make_resource,
                                                 seed_directory, seed_file)


def test_config_validation_and_normalization():
    config = DatabricksVolumeConfig(
        host="https://dbc.example.com/",
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="nested/path",
    )
    assert config.root_path == "/nested/path"
    assert config.host == "https://dbc.example.com"
    with pytest.raises(ValidationError):
        DatabricksVolumeConfig(
            host="https://dbc.example.com",
            catalog="main/other",
            schema="default",
            volume="agent_files",
        )


def test_config_requires_a_host():
    with pytest.raises(ValidationError):
        DatabricksVolumeConfig(catalog="main",
                               schema="default",
                               volume="agent_files")
    with pytest.raises(ValidationError):
        DatabricksVolumeConfig(host="/",
                               catalog="main",
                               schema="default",
                               volume="agent_files")


def test_config_carries_no_credential_fields():
    fields = set(DatabricksVolumeConfig.model_fields)
    assert "token" not in fields
    assert "profile" not in fields


def test_constructor_builds_an_http_client_from_the_provider():
    resource = DatabricksVolumeResource(CONFIG, StaticTokenProvider("tok"))
    client = resource.accessor.client
    assert isinstance(client, HttpDatabricksFilesClient)
    assert client.token_provider.get_token() == "tok"
    assert client.url(
        "files",
        "/Volumes/x") == ("https://dbc.example.com/api/2.0/fs/files/Volumes/x")


def test_backend_path_uses_volume_root_and_strips_mount_prefix():
    config = DatabricksVolumeConfig(
        host="https://dbc.example.com",
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
    )
    path = PathSpec(
        resource_path=mount_key("/volume/reports/latest.md", "/volume"),
        virtual="/volume/reports/latest.md",
        directory="/volume/reports",
    )
    assert backend_path(
        config,
        path) == ("/Volumes/main/default/agent_files/root/reports/latest.md")


def test_resource_state_carries_no_secret_and_demands_an_override():
    resource = make_resource(FakeFilesClient())
    state = resource.get_state()
    assert state["type"] == ResourceName.DATABRICKS_VOLUME
    assert state["needs_override"] is True
    assert state["config"]["host"] == "https://dbc.example.com"
    assert state["config"]["catalog"] == "main"
    assert "token" not in state["config"]
    assert "profile" not in state["config"]
    assert "redacted_fields" not in state


def test_resource_registers_ops():
    resource = make_resource(FakeFilesClient())
    op_names = {op.name for op in resource.ops_list()}
    assert {"read", "readdir", "stat", "write", "create", "unlink"} <= op_names
    assert resource.name == "databricks_volume"
    assert resource.caches_reads is True


def test_resource_registers_commands():
    resource = make_resource(FakeFilesClient())
    command_names = {command.name for command in resource.commands()}
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
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/reports/latest.md"] = b"abcdef"
    files.metadata[f"{root}/reports/latest.md"] = file_metadata(
        6, "Tue, 14 Nov 2023 22:13:20 GMT")
    files.directories[f"{root}/reports"] = [
        file_entry(f"{root}/reports/latest.md", 6)
    ]
    resource = make_resource(files)

    assert await resource.read_bytes(
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume"))) == b"abcdef"
    assert await resource.range_read(
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume")), 1, 4) == b"bcd"
    chunks = [
        chunk async for chunk in resource.read_stream(
            PathSpec.from_str_path(
                "/volume/reports/latest.md",
                mount_key("/volume/reports/latest.md", "/volume")),
            chunk_size=2,
        )
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    file_stat = await resource.stat(
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume")))
    assert file_stat.name == "latest.md"
    assert file_stat.size == 6
    assert file_stat.modified == "2023-11-14T22:13:20+00:00"
    assert await resource.exists(
        PathSpec.from_str_path(
            "/volume/reports/latest.md",
            mount_key("/volume/reports/latest.md", "/volume")))
    assert not await resource.exists(
        PathSpec.from_str_path("/volume/missing.md",
                               mount_key("/volume/missing.md", "/volume")))
    entries = await resource.readdir(
        PathSpec.from_str_path("/volume/reports",
                               mount_key("/volume/reports", "/volume")),
        resource.index,
    )
    assert entries == ["/volume/reports/latest.md"]


@pytest.mark.asyncio
async def test_workspace_read_mode_uses_registered_ops():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/latest.md"] = b"hello"
    files.metadata[f"{root}/latest.md"] = file_metadata(5)
    ws = Workspace({"/volume": make_resource(files)}, mode=MountMode.READ)

    assert await ws.ops.read("/volume/latest.md") == b"hello"
    file_stat = await ws.ops.stat("/volume/latest.md")
    assert file_stat.size == 5


@pytest.mark.asyncio
async def test_resource_exposes_file_write_ops():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    resource = make_resource(files)

    await resource.write(
        PathSpec.from_str_path("/volume/new.txt",
                               mount_key("/volume/new.txt", "/volume")),
        b"hello",
        resource.index,
    )
    await resource.create(
        PathSpec.from_str_path("/volume/empty.txt",
                               mount_key("/volume/empty.txt", "/volume")),
        resource.index,
    )
    await resource.unlink(
        PathSpec.from_str_path("/volume/new.txt",
                               mount_key("/volume/new.txt", "/volume")),
        resource.index,
    )

    assert files.downloads[f"{root}/empty.txt"] == b""
    assert f"{root}/new.txt" not in files.downloads


@pytest.mark.asyncio
async def test_workspace_write_mode_uses_file_write_ops():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    await ws.ops.write("/dbx/new.txt", b"hello")
    await ws.ops.create("/dbx/empty.txt")
    await ws.ops.unlink("/dbx/new.txt")

    assert f"{root}/new.txt" not in files.downloads
    assert files.downloads[f"{root}/empty.txt"] == b""


@pytest.mark.asyncio
async def test_workspace_write_mode_invalidates_parent_directory_index():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    resource = make_resource(files)
    ws = Workspace({"/dbx/": resource}, mode=MountMode.WRITE)

    await resource.index.set_dir("/dbx", [("old.txt",
                                           IndexEntry(
                                               id="/dbx/old.txt",
                                               name="old.txt",
                                               resource_type="file",
                                           ))])
    assert (await resource.index.list_dir("/dbx")).entries == ["/dbx/old.txt"]

    await ws.ops.write("/dbx/new.txt", b"hello")
    assert (await
            resource.index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)

    await resource.index.set_dir("/dbx", [("new.txt",
                                           IndexEntry(
                                               id="/dbx/new.txt",
                                               name="new.txt",
                                               resource_type="file",
                                           ))])
    await ws.ops.create("/dbx/empty.txt")
    assert (await
            resource.index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)

    await resource.index.set_dir("/dbx", [("empty.txt",
                                           IndexEntry(
                                               id="/dbx/empty.txt",
                                               name="empty.txt",
                                               resource_type="file",
                                           ))])
    await ws.ops.unlink("/dbx/empty.txt")
    assert (await
            resource.index.list_dir("/dbx")).status == (LookupStatus.NOT_FOUND)


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_ops():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    with pytest.raises(PermissionError):
        await ws.ops.write("/dbx/new.txt", b"hello")
    with pytest.raises(PermissionError):
        await ws.ops.create("/dbx/empty.txt")
    with pytest.raises(PermissionError):
        await ws.ops.unlink("/dbx/new.txt")


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_and_rm():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    touch_io = await ws.execute("touch /dbx/created.txt")
    rm_io = await ws.execute("rm /dbx/created.txt")

    assert touch_io.exit_code == 0
    assert touch_io.writes == {"/dbx/created.txt": b""}
    assert files.delete_calls == [f"{root}/created.txt"]
    assert f"{root}/created.txt" not in files.downloads
    assert rm_io.exit_code == 0
    assert rm_io.writes == {"/dbx/created.txt": b""}


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_resolves_glob():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_file(files, f"{root}/one.txt", b"one")
    seed_file(files, f"{root}/two.txt", b"two")
    seed_file(files, f"{root}/keep.md", b"keep")
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    io = await ws.execute("rm /dbx/*.txt")

    assert io.exit_code == 0
    assert files.delete_calls == [f"{root}/one.txt", f"{root}/two.txt"]
    assert f"{root}/one.txt" not in files.downloads
    assert f"{root}/two.txt" not in files.downloads
    assert files.downloads[f"{root}/keep.md"] == b"keep"
    assert io.writes == {
        "/dbx/one.txt": b"",
        "/dbx/two.txt": b"",
    }


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_touch_resolves_glob():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_file(files, f"{root}/existing.txt", b"existing")
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    io = await ws.execute("touch /dbx/*.txt")

    assert io.exit_code == 0
    assert files.upload_calls == []
    assert f"{root}/*.txt" not in files.downloads
    assert io.writes == {}


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_rm_rejects_directory():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_directory(files, f"{root}/dir")
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    io = await ws.execute("rm /dbx/dir")

    assert io.exit_code == 1
    assert b"IsADirectoryError" in io.stderr or b"Is a directory" in io.stderr


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_commands():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    touch_io = await ws.execute("touch /dbx/created.txt")
    rm_io = await ws.execute("rm /dbx/created.txt")

    assert touch_io.exit_code == 1
    assert b"read-only mount" in touch_io.stderr
    assert rm_io.exit_code == 1
    assert b"read-only mount" in rm_io.stderr


@pytest.mark.asyncio
async def test_workspace_execute_uses_databricks_volume_mount_for_ls():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.add(root)
    files.metadata[f"{root}/debug_output.json"] = file_metadata(18)
    files.directories[root] = [file_entry(f"{root}/debug_output.json", 18)]
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    io = await ws.execute("ls /dbx")
    slash_io = await ws.execute("ls /dbx/")

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
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/debug_output.json"] = b'{"ok": true}\nsecond\n'
    files.metadata[f"{root}/debug_output.json"] = file_metadata(20)
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    stat_io = await ws.execute("stat /dbx/debug_output.json")
    cat_io = await ws.execute("cat /dbx/debug_output.json")
    head_io = await ws.execute("head -n 1 /dbx/debug_output.json")

    assert stat_io.exit_code == 0
    assert b"name=debug_output.json" in stat_io.stdout
    assert cat_io.exit_code == 0
    assert b'{"ok": true}' in cat_io.stdout
    assert head_io.exit_code == 0
    assert head_io.stdout == b'{"ok": true}\n'


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_find_files():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.update({root, f"{root}/nested"})
    files.metadata[f"{root}/debug_output.json"] = file_metadata(2)
    files.metadata[f"{root}/nested/result.txt"] = file_metadata(2)
    files.directories[root] = [
        file_entry(f"{root}/debug_output.json", 2),
        directory_entry(f"{root}/nested"),
    ]
    files.directories[f"{root}/nested"] = [
        file_entry(f"{root}/nested/result.txt", 2)
    ]
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    io = await ws.execute("find /dbx -maxdepth 2 -type f")

    assert io.exit_code == 0
    assert b"/dbx/debug_output.json" in io.stdout
    assert b"/dbx/nested/result.txt" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_recursive_grep_and_rg():
    files = FakeFilesClient()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.update({
        root,
        f"{root}/nested",
        f"{root}/nested/deeper",
    })
    files.metadata[f"{root}/nested/info.txt"] = file_metadata(17)
    files.metadata[f"{root}/nested/deeper/notes.md"] = file_metadata(26)
    files.downloads[f"{root}/nested/info.txt"] = b"alpha debug line\n"
    files.downloads[f"{root}/nested/deeper/notes.md"] = (
        b"# Notes\nbeta debug detail\n")
    files.directories[root] = [
        directory_entry(f"{root}/nested"),
    ]
    files.directories[f"{root}/nested"] = [
        file_entry(f"{root}/nested/info.txt", 17),
        directory_entry(f"{root}/nested/deeper"),
    ]
    files.directories[f"{root}/nested/deeper"] = [
        file_entry(f"{root}/nested/deeper/notes.md", 26)
    ]
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    grep_io = await ws.execute("grep -R -n debug /dbx/nested")
    rg_io = await ws.execute("rg debug /dbx/nested")

    assert grep_io.exit_code == 0
    assert b"/dbx/nested/info.txt:1:alpha debug line" in grep_io.stdout
    assert b"/dbx/nested/deeper/notes.md:2:beta debug detail" in (
        grep_io.stdout)
    assert not grep_io.stderr
    assert rg_io.exit_code == 0
    assert b"/dbx/nested/info.txt:alpha debug line" in rg_io.stdout
    assert b"/dbx/nested/deeper/notes.md:beta debug detail" in rg_io.stdout
    assert not rg_io.stderr
