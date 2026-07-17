import posixpath
from io import BytesIO
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.databricks_volume.path import backend_path
from mirage.resource.databricks_volume import DatabricksVolumeConfig
from mirage.types import PathSpec


class NotFoundError(Exception):
    status_code = 404


class ToThreadRecorder:

    def __init__(self) -> None:
        self.calls = []

    async def __call__(self, fn, *args, **kwargs):
        self.calls.append((fn, args, kwargs))
        return fn(*args, **kwargs)


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
        self.upload_calls: list[tuple[str, bytes, bool]] = []
        self.delete_calls: list[str] = []
        self.create_directory_calls: list[str] = []
        self.delete_directory_calls: list[str] = []

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
        self.metadata[path] = file_metadata(len(data))
        self._upsert_directory_entry(parent, file_entry(path, len(data)))

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
    return backend_path(databricks_config, PathSpec.from_str_path("/"))


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


def file_metadata(size: int = 0, modified: str | None = None) -> object:
    return SimpleNamespace(
        content_length=size,
        content_type=None,
        last_modified=modified,
    )


def directory_entry(path: str, modified: int | None = None) -> object:
    return SimpleNamespace(path=path,
                           is_directory=True,
                           file_size=None,
                           last_modified=modified)


def file_entry(path: str,
               size: int = 0,
               modified: int | None = None) -> object:
    return SimpleNamespace(path=path,
                           is_directory=False,
                           file_size=size,
                           last_modified=modified)
