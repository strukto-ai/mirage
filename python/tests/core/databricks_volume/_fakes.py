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
from collections.abc import AsyncIterator

import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.databricks_volume.errors import DatabricksVolumeApiError
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.types import (DatabricksEntry,
                                                 DatabricksFileMeta)
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.types import PathSpec
from mirage.utils.ranges import ByteWindow, slice_window


def not_found(path: str) -> DatabricksVolumeApiError:
    """The error the HTTP client raises for a 404 on either endpoint.

    Args:
        path (str): the backend path the caller asked for.
    """
    return DatabricksVolumeApiError(f"databricks_volume: {path} → 404", 404,
                                    "RESOURCE_DOES_NOT_EXIST")


class FakeFilesClient:
    """A dict-backed DatabricksFilesClient that records its calls."""

    def __init__(self) -> None:
        self.downloads: dict[str, bytes] = {}
        self.metadata: dict[str, DatabricksFileMeta] = {}
        self.directory_metadata: set[str] = set()
        self.directories: dict[str, list[DatabricksEntry]] = {}
        self.metadata_errors: dict[str, Exception] = {}
        self.directory_metadata_errors: dict[str, Exception] = {}
        self.download_calls: list[str] = []
        self.download_windows: list[ByteWindow | None] = []
        self.stream_calls: list[str] = []
        self.get_metadata_calls: list[str] = []
        self.get_directory_metadata_calls: list[str] = []
        self.list_directory_calls: list[str] = []
        self.upload_calls: list[tuple[str, bytes]] = []
        self.delete_calls: list[str] = []
        self.create_directory_calls: list[str] = []
        self.delete_directory_calls: list[str] = []

    async def download(self,
                       path: str,
                       window: ByteWindow | None = None) -> bytes:
        self.download_calls.append(path)
        self.download_windows.append(window)
        if path not in self.downloads:
            raise not_found(path)
        data = self.downloads[path]
        if window is None:
            return data
        return slice_window(data, window.offset, window.size)

    async def download_stream(self, path: str,
                              chunk_size: int) -> AsyncIterator[bytes]:
        self.stream_calls.append(path)
        if path not in self.downloads:
            raise not_found(path)
        data = self.downloads[path]
        for start in range(0, len(data), chunk_size):
            yield data[start:start + chunk_size]

    async def get_metadata(self, path: str) -> DatabricksFileMeta:
        self.get_metadata_calls.append(path)
        if path in self.metadata_errors:
            raise self.metadata_errors[path]
        if path not in self.metadata:
            raise not_found(path)
        return self.metadata[path]

    async def get_directory_metadata(self, path: str) -> None:
        self.get_directory_metadata_calls.append(path)
        if path in self.directory_metadata_errors:
            raise self.directory_metadata_errors[path]
        if path not in self.directory_metadata:
            raise not_found(path)

    async def list_directory(self, path: str) -> list[DatabricksEntry]:
        self.list_directory_calls.append(path)
        if path not in self.directories:
            raise not_found(path)
        return self.directories[path]

    def add_directory(self, path: str) -> None:
        """Seed a directory and its ancestors, as the API's PUT does.

        Args:
            path (str): absolute backend path of the directory.
        """
        cur = ""
        for part in path.strip("/").split("/"):
            cur = cur + "/" + part
            if cur in self.directory_metadata:
                continue
            self.directory_metadata.add(cur)
            self.directories.setdefault(cur, [])
            parent = posixpath.dirname(cur) or "/"
            self._upsert_directory_entry(parent, directory_entry(cur))

    async def create_directory(self, path: str) -> None:
        self.create_directory_calls.append(path)
        self.add_directory(path)

    async def delete_directory(self, path: str) -> None:
        self.delete_directory_calls.append(path)
        if path not in self.directory_metadata:
            raise not_found(path)
        if self.directories.get(path):
            raise OSError(f"directory not empty: {path}")
        self.directory_metadata.discard(path)
        self.directories.pop(path, None)
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        self.directories[parent] = [
            entry for entry in self.directories.get(parent, [])
            if entry.path != path
        ]

    async def upload(self, path: str, data: bytes) -> None:
        self.upload_calls.append((path, data))
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        if parent not in self.directory_metadata:
            if parent in self.metadata:
                raise NotADirectoryError(parent)
            raise not_found(parent)
        if path in self.directory_metadata:
            raise IsADirectoryError(path)
        self.downloads[path] = data
        self.metadata[path] = file_metadata(len(data))
        self._upsert_directory_entry(parent, file_entry(path, len(data)))

    async def delete(self, path: str) -> None:
        self.delete_calls.append(path)
        if path in self.directory_metadata:
            raise IsADirectoryError(path)
        if path not in self.metadata and path not in self.downloads:
            raise not_found(path)
        self.metadata.pop(path, None)
        self.downloads.pop(path, None)
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        self.directories[parent] = [
            entry for entry in self.directories.get(parent, [])
            if entry.path != path
        ]

    def _upsert_directory_entry(self, parent: str,
                                entry: DatabricksEntry) -> None:
        entries = [
            existing for existing in self.directories.get(parent, [])
            if existing.path != entry.path
        ]
        entries.append(entry)
        self.directories[parent] = sorted(entries, key=lambda item: item.path)


@pytest.fixture
def databricks_config() -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(
        host="https://dbc.example.com",
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
    )


@pytest.fixture
def remote_root(databricks_config: DatabricksVolumeConfig) -> str:
    return backend_path(databricks_config, PathSpec.from_str_path("/"))


@pytest.fixture
def files() -> FakeFilesClient:
    return FakeFilesClient()


@pytest.fixture
def accessor(
    databricks_config: DatabricksVolumeConfig,
    files: FakeFilesClient,
) -> DatabricksVolumeAccessor:
    return DatabricksVolumeAccessor(databricks_config, files)


@pytest.fixture
def index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore(ttl=600)


def file_metadata(size: int = 0,
                  modified: str | None = None) -> DatabricksFileMeta:
    return DatabricksFileMeta(
        content_length=size,
        content_type=None,
        last_modified=modified,
    )


def directory_entry(path: str, modified: int | None = None) -> DatabricksEntry:
    return DatabricksEntry(path=path,
                           is_directory=True,
                           file_size=None,
                           last_modified=modified)


def file_entry(path: str,
               size: int | None = 0,
               modified: int | None = None) -> DatabricksEntry:
    return DatabricksEntry(path=path,
                           is_directory=False,
                           file_size=size,
                           last_modified=modified)


CONFIG = DatabricksVolumeConfig(
    host="https://dbc.example.com",
    catalog="main",
    schema="default",
    volume="agent_files",
    root_path="/root",
)


def make_resource(files: FakeFilesClient) -> DatabricksVolumeResource:
    """A resource wired to a fake client, with no HTTP client built.

    Args:
        files (FakeFilesClient): the client the accessor reaches.
    """
    return DatabricksVolumeResource._from_files_client(CONFIG, files)


def seed_directory(files: FakeFilesClient, path: str) -> None:
    """Make one directory exist, without seeding its ancestors.

    Args:
        files (FakeFilesClient): the client to seed.
        path (str): absolute backend path of the directory.
    """
    files.directory_metadata.add(path)
    files.directories.setdefault(path, [])


def seed_file(files: FakeFilesClient, path: str, data: bytes) -> None:
    """Make one file exist and list it under its parent.

    Args:
        files (FakeFilesClient): the client to seed.
        path (str): absolute backend path of the file.
        data (bytes): the file's content.
    """
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = file_metadata(len(data))
    files.directories.setdefault(parent, [])
    files.directories[parent].append(file_entry(path, len(data)))
