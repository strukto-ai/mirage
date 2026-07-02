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

import posixpath
from io import BytesIO
from types import SimpleNamespace
from urllib.parse import unquote

import pytest
from pydantic import ValidationError

from mirage import MountMode, Workspace
from mirage.cache.index import IndexEntry, LookupStatus
from mirage.core.databricks_volume.path import backend_path
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key


class NotFoundError(Exception):
    status_code = 404


class FakeDownload:

    def __init__(self, data: bytes) -> None:
        self.contents = BytesIO(data)


class FakeFiles:

    def __init__(self) -> None:
        self.downloads: dict[str, bytes] = {}
        self.metadata: dict[str, object] = {}
        self.directory_metadata: set[str] = set()
        self.directories: dict[str, list[object]] = {}
        self.upload_calls: list[tuple[str, bytes, bool]] = []
        self.delete_calls: list[str] = []
        self.create_directory_calls: list[str] = []
        self.delete_directory_calls: list[str] = []

    def download(self, path: str) -> FakeDownload:
        if path not in self.downloads:
            raise NotFoundError(path)
        return FakeDownload(self.downloads[path])

    def get_metadata(self, path: str) -> object:
        if path not in self.metadata:
            raise NotFoundError(path)
        return self.metadata[path]

    def get_directory_metadata(self, path: str) -> None:
        if path not in self.directory_metadata:
            raise NotFoundError(path)

    def list_directory_contents(self, path: str) -> list[object]:
        if path not in self.directories:
            raise NotFoundError(path)
        return self.directories[path]

    def create_directory(self, path: str) -> None:
        self.create_directory_calls.append(path)
        cur = ""
        for part in path.strip("/").split("/"):
            cur = cur + "/" + part
            if cur in self.directory_metadata:
                continue
            self.directory_metadata.add(cur)
            self.metadata[cur] = SimpleNamespace(is_directory=True)
            self.directories.setdefault(cur, [])
            parent = posixpath.dirname(cur) or "/"
            self._upsert_directory_entry(
                parent, SimpleNamespace(path=cur, is_directory=True))

    def delete_directory(self, path: str) -> None:
        self.delete_directory_calls.append(path)
        if path not in self.directory_metadata:
            raise NotFoundError(path)
        if self.directories.get(path):
            raise OSError(f"directory not empty: {path}")
        self.directory_metadata.discard(path)
        self.metadata.pop(path, None)
        self.directories.pop(path, None)
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        self.directories[parent] = [
            entry for entry in self.directories.get(parent, [])
            if getattr(entry, "path", None) != path
        ]

    def upload(self, path: str, contents, overwrite: bool = False) -> None:
        data = contents.read()
        self.upload_calls.append((path, data, overwrite))
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        if parent not in self.directory_metadata:
            if parent in self.metadata:
                raise NotADirectoryError(parent)
            raise NotFoundError(parent)
        if path in self.directory_metadata:
            raise IsADirectoryError(path)
        self.downloads[path] = data
        self.metadata[path] = SimpleNamespace(
            content_length=len(data),
            content_type=None,
            last_modified=None,
        )
        self._upsert_directory_entry(
            parent,
            SimpleNamespace(
                path=path,
                is_directory=False,
                file_size=len(data),
            ),
        )

    def delete(self, path: str) -> None:
        self.delete_calls.append(path)
        if path in self.directory_metadata:
            raise IsADirectoryError(path)
        if path not in self.metadata and path not in self.downloads:
            raise NotFoundError(path)
        self.metadata.pop(path, None)
        self.downloads.pop(path, None)
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        self.directories[parent] = [
            entry for entry in self.directories.get(parent, [])
            if getattr(entry, "path", None) != path
        ]

    def _upsert_directory_entry(self, parent: str, entry: object) -> None:
        entries = [
            existing for existing in self.directories.get(parent, [])
            if getattr(existing, "path", None) != getattr(entry, "path", None)
        ]
        entries.append(entry)
        self.directories[parent] = sorted(
            entries, key=lambda item: getattr(item, "path", ""))


def _apply_range_header(data: bytes, range_header: str) -> bytes:
    if not range_header.startswith("bytes="):
        raise ValueError(f"unsupported range header: {range_header}")
    start_text, end_text = range_header.removeprefix("bytes=").split("-", 1)
    start = int(start_text) if start_text else 0
    end = int(end_text) + 1 if end_text else None
    return data[start:end]


class FakeApiClient:

    def __init__(self, files: FakeFiles) -> None:
        self.files = files

    def do(
        self,
        method: str,
        path: str | None = None,
        url: str | None = None,
        query: dict | None = None,
        headers: dict | None = None,
        body: dict | None = None,
        raw: bool = False,
        files: object = None,
        data: object = None,
        auth: object = None,
        response_headers: list[str] | None = None,
    ) -> dict:
        if method != "GET" or path is None:
            raise ValueError(f"unsupported fake API call: {method} {path}")
        remote_path = unquote(path.removeprefix("/api/2.0/fs/files"))
        if remote_path not in self.files.downloads:
            raise NotFoundError(remote_path)
        payload = self.files.downloads[remote_path]
        range_header = (headers or {}).get("Range")
        if range_header is not None:
            payload = _apply_range_header(payload, range_header)
        return {
            "contents": BytesIO(payload),
            "content-length": str(len(payload)),
            "accept-ranges": "bytes",
        }


class FakeClient:

    def __init__(self, files: FakeFiles) -> None:
        self.files = files
        self.api_client = FakeApiClient(files)


def make_resource(files: FakeFiles) -> DatabricksVolumeResource:
    return DatabricksVolumeResource(
        DatabricksVolumeConfig(
            catalog="main",
            schema="default",
            volume="agent_files",
            root_path="/root",
            token="secret",
        ),
        client=FakeClient(files),
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
        ))


def test_config_validation_and_normalization():
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="nested/path",
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
    )
    path = PathSpec(
        resource_path=mount_key("/volume/reports/latest.md", "/volume"),
        virtual="/volume/reports/latest.md",
        directory="/volume/reports",
    )
    assert backend_path(
        config,
        path) == ("/Volumes/main/default/agent_files/root/reports/latest.md")


def test_resource_state_redacts_token():
    resource = make_resource(FakeFiles())
    state = resource.get_state()
    assert state["type"] == ResourceName.DATABRICKS_VOLUME
    assert state["needs_override"] is True
    assert state["config"]["token"] == "<REDACTED>"
    assert state["config"]["host"] is None
    assert state["config"]["catalog"] == "main"
    assert "token" in state["redacted_fields"]


def test_resource_registers_ops():
    resource = make_resource(FakeFiles())
    op_names = {op.name for op in resource.ops_list()}
    assert {"read", "readdir", "stat", "write", "create", "unlink"} <= op_names
    assert resource.name == "databricks_volume"
    assert resource.caches_reads is True


def test_resource_registers_commands():
    resource = make_resource(FakeFiles())
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
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/latest.md"] = b"hello"
    files.metadata[f"{root}/latest.md"] = SimpleNamespace(
        content_length=5,
        content_type=None,
        last_modified=None,
    )
    ws = Workspace({"/volume": make_resource(files)}, mode=MountMode.READ)

    assert await ws.ops.read("/volume/latest.md") == b"hello"
    file_stat = await ws.ops.stat("/volume/latest.md")
    assert file_stat.size == 5


@pytest.mark.asyncio
async def test_resource_exposes_file_write_ops():
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
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
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_directory(files, f"{root}/dir")
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.WRITE)

    io = await ws.execute("rm /dbx/dir")

    assert io.exit_code == 1
    assert b"IsADirectoryError" in io.stderr or b"Is a directory" in io.stderr


@pytest.mark.asyncio
async def test_read_only_mount_rejects_file_write_commands():
    files = FakeFiles()
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
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.downloads[f"{root}/debug_output.json"] = b'{"ok": true}\nsecond\n'
    files.metadata[f"{root}/debug_output.json"] = SimpleNamespace(
        content_length=20,
        content_type=None,
        last_modified=None,
    )
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
    ws = Workspace({"/dbx/": make_resource(files)}, mode=MountMode.READ)

    io = await ws.execute("find /dbx -maxdepth 2 -type f")

    assert io.exit_code == 0
    assert b"/dbx/debug_output.json" in io.stdout
    assert b"/dbx/nested/result.txt" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_recursive_grep_and_rg():
    files = FakeFiles()
    root = "/Volumes/main/default/agent_files/root"
    files.directory_metadata.update({
        root,
        f"{root}/nested",
        f"{root}/nested/deeper",
    })
    files.metadata[f"{root}/nested"] = SimpleNamespace(is_directory=True)
    files.metadata[f"{root}/nested/deeper"] = SimpleNamespace(
        is_directory=True)
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
        b"# Notes\nbeta debug detail\n")
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
