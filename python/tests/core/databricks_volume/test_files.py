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

from io import BytesIO
from types import SimpleNamespace

import pytest

from mirage import MountMode, Workspace
from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.databricks_volume.files import (create, mkdir, read_bytes,
                                                 readdir, stat, truncate,
                                                 unlink, write_bytes)
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.types import FileType, PathSpec


class FakeDatabricksNotFound(Exception):

    status_code = 404
    error_code = "RESOURCE_DOES_NOT_EXIST"


class FakeFilesAPI:

    def __init__(
        self,
        files: dict[str, bytes] | None = None,
        directories: set[str] | None = None,
    ) -> None:
        self.files = dict(files or {})
        self.directories = set(directories or set())
        self.downloaded: list[str] = []
        self.uploaded: list[tuple[str, bytes, bool | None]] = []
        self.created_directories: list[str] = []
        self.deleted_files: list[str] = []
        self.deleted_directories: list[str] = []

    def download(self, file_path: str):
        if file_path not in self.files:
            raise FakeDatabricksNotFound(file_path)
        self.downloaded.append(file_path)
        return SimpleNamespace(contents=BytesIO(self.files[file_path]))

    def upload(self,
               file_path: str,
               contents,
               overwrite: bool | None = None,
               **kwargs) -> None:
        data = contents.read()
        self.files[file_path] = data
        self.uploaded.append((file_path, data, overwrite))

    def list_directory_contents(self, directory_path: str):
        if not self._is_directory(directory_path):
            raise FakeDatabricksNotFound(directory_path)

        prefix = directory_path.rstrip("/") + "/"
        children: dict[str, SimpleNamespace] = {}
        for directory in self.directories:
            if not directory.startswith(prefix):
                continue
            rest = directory[len(prefix):]
            if not rest or "/" in rest:
                continue
            children[rest] = SimpleNamespace(
                name=rest,
                path=directory,
                is_directory=True,
                file_size=None,
                last_modified=None,
            )
        for file_path, data in self.files.items():
            if not file_path.startswith(prefix):
                continue
            rest = file_path[len(prefix):]
            name = rest.split("/", 1)[0]
            child_path = prefix + name
            is_directory = "/" in rest
            children.setdefault(
                name,
                SimpleNamespace(
                    name=name,
                    path=child_path,
                    is_directory=is_directory,
                    file_size=None if is_directory else len(data),
                    last_modified=None if is_directory else 1710000000000,
                ),
            )
        return iter(children.values())

    def get_metadata(self, file_path: str):
        if file_path not in self.files:
            raise FakeDatabricksNotFound(file_path)
        return SimpleNamespace(
            content_length=len(self.files[file_path]),
            content_type="text/plain",
            last_modified="Wed, 01 May 2024 12:00:00 GMT",
        )

    def get_directory_metadata(self, directory_path: str):
        if not self._is_directory(directory_path):
            raise FakeDatabricksNotFound(directory_path)
        return SimpleNamespace()

    def create_directory(self, directory_path: str) -> None:
        self.directories.add(directory_path.rstrip("/"))
        self.created_directories.append(directory_path)

    def delete(self, file_path: str) -> None:
        if file_path not in self.files:
            raise FakeDatabricksNotFound(file_path)
        del self.files[file_path]
        self.deleted_files.append(file_path)

    def delete_directory(self, directory_path: str) -> None:
        directory_path = directory_path.rstrip("/")
        if not self._is_directory(directory_path):
            raise FakeDatabricksNotFound(directory_path)
        self.directories.discard(directory_path)
        self.deleted_directories.append(directory_path)

    def _is_directory(self, directory_path: str) -> bool:
        directory_path = directory_path.rstrip("/")
        prefix = directory_path + "/"
        return (directory_path in self.directories
                or any(path.startswith(prefix) for path in self.files)
                or any(path.startswith(prefix) for path in self.directories))


class FakeWorkspaceClient:

    def __init__(self, files: FakeFilesAPI) -> None:
        self.files = files


def make_accessor(files: FakeFilesAPI) -> DatabricksVolumeAccessor:
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
    )
    return DatabricksVolumeAccessor(config, FakeWorkspaceClient(files))


def test_resource_state_redacts_token_and_keeps_schema_alias():
    files = FakeFilesAPI()
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        host="https://example.cloud.databricks.com",
        token="dapi-token",
    )
    resource = DatabricksVolumeResource(config,
                                        client=FakeWorkspaceClient(files))

    state = resource.get_state()

    assert state["config"]["schema"] == "default"
    assert "schema_name" not in state["config"]
    assert state["config"]["token"] == "<REDACTED>"


@pytest.mark.asyncio
async def test_read_maps_virtual_path_to_volume_path():
    remote_path = "/Volumes/main/default/agent_files/reports/latest.md"
    files = FakeFilesAPI({remote_path: b"hello"})
    accessor = make_accessor(files)

    result = await read_bytes(
        accessor,
        PathSpec(
            original="/volume/reports/latest.md",
            directory="/volume/reports",
            prefix="/volume",
        ),
    )

    assert result == b"hello"
    assert files.downloaded == [remote_path]


@pytest.mark.asyncio
async def test_readdir_returns_virtual_paths_with_mount_prefix():
    files = FakeFilesAPI(
        {
            "/Volumes/main/default/agent_files/readme.txt": b"hello",
            "/Volumes/main/default/agent_files/reports/latest.md": b"report",
        },
        directories={"/Volumes/main/default/agent_files/reports"},
    )
    accessor = make_accessor(files)
    index = RAMIndexCacheStore(ttl=0)

    result = await readdir(
        accessor,
        PathSpec(original="/volume", directory="/volume", prefix="/volume"),
        index,
    )

    assert result == ["/volume/readme.txt", "/volume/reports"]


@pytest.mark.asyncio
async def test_stat_returns_file_and_directory_metadata():
    files = FakeFilesAPI(
        {"/Volumes/main/default/agent_files/reports/latest.md": b"hello"},
        directories={"/Volumes/main/default/agent_files/reports"},
    )
    accessor = make_accessor(files)

    file_stat = await stat(
        accessor,
        PathSpec(
            original="/volume/reports/latest.md",
            directory="/volume/reports",
            prefix="/volume",
        ),
    )
    dir_stat = await stat(
        accessor,
        PathSpec(
            original="/volume/reports",
            directory="/volume",
            prefix="/volume",
        ),
    )

    assert file_stat.name == "latest.md"
    assert file_stat.size == 5
    assert file_stat.type == FileType.TEXT
    assert file_stat.fingerprint == "Wed, 01 May 2024 12:00:00 GMT:5"
    assert dir_stat.name == "reports"
    assert dir_stat.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_write_create_truncate_and_delete_use_files_api():
    remote_path = "/Volumes/main/default/agent_files/reports/new.txt"
    files = FakeFilesAPI(directories={"/Volumes/main/default/agent_files"})
    accessor = make_accessor(files)
    path = PathSpec(
        original="/volume/reports/new.txt",
        directory="/volume/reports",
        prefix="/volume",
    )

    await mkdir(
        accessor,
        PathSpec(
            original="/volume/reports",
            directory="/volume",
            prefix="/volume",
        ),
    )
    await write_bytes(accessor, path, b"abcdef")
    await truncate(accessor, path, 3)
    await create(
        accessor,
        PathSpec(
            original="/volume/reports/empty.txt",
            directory="/volume/reports",
            prefix="/volume",
        ),
    )
    await unlink(accessor, path)

    assert files.created_directories == [
        "/Volumes/main/default/agent_files/reports"
    ]
    assert files.uploaded == [
        (remote_path, b"abcdef", True),
        (remote_path, b"abc", True),
        ("/Volumes/main/default/agent_files/reports/empty.txt", b"", False),
    ]
    assert files.deleted_files == [remote_path]


@pytest.mark.asyncio
async def test_workspace_ops_route_to_databricks_volume_resource():
    read_path = "/Volumes/main/default/agent_files/reports/latest.md"
    write_path = "/Volumes/main/default/agent_files/reports/new.txt"
    files = FakeFilesAPI({read_path: b"hello"})
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
    )
    resource = DatabricksVolumeResource(config,
                                        client=FakeWorkspaceClient(files))
    ws = Workspace({"/volume": resource}, mode=MountMode.WRITE)

    data = await ws.ops.read("/volume/reports/latest.md")
    await ws.ops.write("/volume/reports/new.txt", b"new")

    assert data == b"hello"
    assert files.uploaded[-1] == (write_path, b"new", True)
