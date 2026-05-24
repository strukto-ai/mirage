from io import BytesIO
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.databricks_volume.path import backend_path
from mirage.resource.databricks_volume import DatabricksVolumeConfig


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
        self.metadata_errors: dict[str, Exception] = {}
        self.directory_metadata_errors: dict[str, Exception] = {}
        self.download_calls: list[str] = []
        self.get_metadata_calls: list[str] = []
        self.get_directory_metadata_calls: list[str] = []
        self.list_directory_calls: list[str] = []

    def download(self, path: str) -> FakeDownload:
        self.download_calls.append(path)
        if path not in self.downloads:
            raise NotFoundError(path)
        return FakeDownload(self.downloads[path])

    def get_metadata(self, path: str) -> object:
        self.get_metadata_calls.append(path)
        if path in self.metadata_errors:
            raise self.metadata_errors[path]
        if path not in self.metadata:
            raise NotFoundError(path)
        return self.metadata[path]

    def get_directory_metadata(self, path: str) -> None:
        self.get_directory_metadata_calls.append(path)
        if path in self.directory_metadata_errors:
            raise self.directory_metadata_errors[path]
        if path not in self.directory_metadata:
            raise NotFoundError(path)

    def list_directory_contents(self, path: str) -> list[object]:
        self.list_directory_calls.append(path)
        if path not in self.directories:
            raise NotFoundError(path)
        return self.directories[path]


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
        self.do_calls: list[dict[str, object]] = []

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
        call = {
            "method": method,
            "path": path,
            "url": url,
            "query": query,
            "headers": headers or {},
            "body": body,
            "raw": raw,
            "files": files,
            "data": data,
            "auth": auth,
            "response_headers": response_headers,
        }
        self.do_calls.append(call)
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


@pytest.fixture
def databricks_config() -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        token="secret",
    )


@pytest.fixture
def remote_root(databricks_config: DatabricksVolumeConfig) -> str:
    return backend_path(databricks_config, "/")


@pytest.fixture
def files() -> FakeFiles:
    return FakeFiles()


@pytest.fixture
def accessor(
    databricks_config: DatabricksVolumeConfig,
    files: FakeFiles,
) -> DatabricksVolumeAccessor:
    return DatabricksVolumeAccessor(databricks_config, FakeClient(files))


@pytest.fixture
def index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore(ttl=600)


def file_metadata(size: int = 0, modified: int | None = None) -> object:
    return SimpleNamespace(
        is_directory=False,
        file_size=size,
        modification_time=modified,
    )


def directory_entry(path: str) -> object:
    return SimpleNamespace(path=path, is_directory=True, file_size=None)


def file_entry(path: str, size: int = 0) -> object:
    return SimpleNamespace(path=path, is_directory=False, file_size=size)
