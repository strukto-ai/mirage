import json
import posixpath
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from threading import Thread
from types import SimpleNamespace
from typing import Any
from urllib.parse import unquote, urlsplit

import pytest

from mirage.core.databricks_volume.errors import DatabricksVolumeApiError

servers: list["FakeFiles"] = []


class NotFoundError(DatabricksVolumeApiError):
    def __init__(self, path: str) -> None:
        super().__init__(path, 404, "RESOURCE_DOES_NOT_EXIST")


class FakeDownload:
    def __init__(self, data: bytes) -> None:
        self.contents = BytesIO(data)


class FakeFiles:
    def __init__(self) -> None:
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(_Handler, files=self)
        )
        self.thread = Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        self.thread.start()
        servers.append(self)
        self.host = f"http://127.0.0.1:{self.server.server_port}"
        self.requests: list[tuple[str, str, str | None]] = []
        self.ignore_range = False
        self.range_headers: list[str | None] = []
        self.downloads: dict[str, bytes] = {}
        self.metadata: dict[str, Any] = {}
        self.directory_metadata: set[str] = set()
        self.directories: dict[str, list[Any]] = {}
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

    def get_metadata(self, path: str) -> Any:
        self.get_metadata_calls.append(path)
        if path in self.metadata_errors:
            raise self.metadata_errors[path]
        if path not in self.metadata or getattr(
            self.metadata[path], "is_directory", False
        ):
            raise NotFoundError(path)
        return self.metadata[path]

    def get_directory_metadata(self, path: str) -> None:
        self.get_directory_metadata_calls.append(path)
        if path in self.directory_metadata_errors:
            raise self.directory_metadata_errors[path]
        if path not in self.directory_metadata:
            raise NotFoundError(path)

    def list_directory_contents(self, path: str) -> list[Any]:
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
                parent, SimpleNamespace(path=cur, is_directory=True)
            )

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
            entry
            for entry in self.directories.get(parent, [])
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
            entry
            for entry in self.directories.get(parent, [])
            if getattr(entry, "path", None) != path
        ]

    def _upsert_directory_entry(self, parent: str, entry: Any) -> None:
        entries = [
            existing
            for existing in self.directories.get(parent, [])
            if getattr(existing, "path", None) != getattr(entry, "path", None)
        ]
        entries.append(entry)
        self.directories[parent] = sorted(
            entries, key=lambda item: getattr(item, "path", "")
        )


class _Handler(BaseHTTPRequestHandler):
    def __init__(self, *args: Any, files: FakeFiles, **kwargs: Any) -> None:
        self.files = files
        super().__init__(*args, **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _respond(
        self,
        status: int,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        if headers is None or "Content-Length" not in headers:
            self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self) -> None:
        files = self.files
        files.requests.append(
            (self.command, self.path, self.headers.get("Authorization"))
        )
        path = unquote(urlsplit(self.path).path)
        file_endpoint = path.startswith("/api/2.0/fs/files/")
        remote = path.removeprefix(
            "/api/2.0/fs/files" if file_endpoint else "/api/2.0/fs/directories"
        )
        try:
            if self.command == "HEAD":
                if file_endpoint:
                    metadata = files.get_metadata(remote)
                    headers = {}
                    size = getattr(metadata, "content_length", None)
                    if size is not None:
                        headers["Content-Length"] = str(size)
                    modified = getattr(metadata, "last_modified", None)
                    if modified is not None:
                        headers["Last-Modified"] = modified
                    self._respond(200, headers=headers)
                else:
                    files.get_directory_metadata(remote)
                    self._respond(200)
            elif self.command == "GET" and file_endpoint:
                payload = files.download(remote).contents.read()
                status = 200
                window = self.headers.get("Range")
                files.range_headers.append(window)
                if window and not files.ignore_range:
                    start_text, end_text = window.removeprefix("bytes=").split(
                        "-", 1
                    )
                    payload = payload[
                        int(start_text) : None
                        if not end_text
                        else int(end_text) + 1
                    ]
                    status = 206
                self._respond(status, payload)
            elif self.command == "GET":
                entries = files.list_directory_contents(remote)
                body = {"contents": [vars(entry) for entry in entries]}
                self._respond(
                    200,
                    json.dumps(body).encode(),
                    {"Content-Type": "application/json"},
                )
            elif self.command == "PUT" and file_endpoint:
                payload = self.rfile.read(
                    int(self.headers.get("Content-Length", "0"))
                )
                files.upload(
                    remote,
                    BytesIO(payload),
                    overwrite="overwrite=true" in self.path,
                )
                self._respond(204)
            elif self.command == "PUT":
                files.create_directory(remote)
                self._respond(204)
            elif self.command == "DELETE" and file_endpoint:
                files.delete(remote)
                self._respond(204)
            elif self.command == "DELETE":
                files.delete_directory(remote)
                self._respond(204)
            else:
                self._respond(405)
        except Exception as exc:
            status = (
                exc.status
                if isinstance(exc, DatabricksVolumeApiError)
                else 500
            )
            body = json.dumps(
                {
                    "error_code": "RESOURCE_DOES_NOT_EXIST"
                    if status == 404
                    else "INTERNAL_ERROR",
                    "message": str(exc),
                }
            )
            self._respond(
                status, body.encode(), {"Content-Type": "application/json"}
            )

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch


@pytest.fixture(autouse=True)
def databricks_http_cleanup():
    yield
    while servers:
        files = servers.pop()
        files.server.shutdown()
        files.server.server_close()
        files.thread.join()


def file_metadata(
    size: int = 0, modified: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(content_length=size, last_modified=modified)


def directory_entry(path: str, modified: int | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        path=path, is_directory=True, file_size=None, last_modified=modified
    )


def file_entry(
    path: str, size: int | None = 0, modified: int | None = None
) -> SimpleNamespace:
    return SimpleNamespace(
        path=path, is_directory=False, file_size=size, last_modified=modified
    )
