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

import json
import urllib.error
import urllib.request
from io import BytesIO
from types import SimpleNamespace
from typing import Any
from urllib.parse import quote, urlencode


# A stand-in for databricks-sdk's WorkspaceClient, injected into
# DatabricksVolumeVFS so the VFS under test talks HTTP to the fake
# instead of to a real workspace. It lives with the python runner rather than
# with the fake, because the fake is a TypeScript kit service now and this is
# the one piece of the old databricks_server.py that was never a server.
class DatabricksNotFound(Exception):

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.status_code = 404
        self.error_code = "RESOURCE_DOES_NOT_EXIST"


def _http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> Any:
    request = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        return urllib.request.urlopen(request)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise DatabricksNotFound(url) from exc
        raise


class _HttpFiles:

    def __init__(self, client: "HttpFilesClient") -> None:
        self._client = client

    def upload(self,
               file_path: str,
               contents: Any,
               overwrite: bool = False) -> None:
        query = {"overwrite": "true"} if overwrite else None
        url = self._client.files_url(file_path, query)
        headers = self._client.auth(
            {"Content-Type": "application/octet-stream"})
        _http_request("PUT", url, headers, contents.read()).close()

    def download(self, file_path: str) -> SimpleNamespace:
        url = self._client.files_url(file_path)
        response = _http_request(
            "GET", url,
            self._client.auth({"Accept": "application/octet-stream"}))
        data = response.read()
        response.close()
        return SimpleNamespace(contents=BytesIO(data))

    def get_metadata(self, file_path: str) -> SimpleNamespace:
        url = self._client.files_url(file_path)
        response = _http_request("HEAD", url, self._client.auth())
        length = response.headers.get("Content-Length")
        modified = response.headers.get("Last-Modified")
        response.close()
        return SimpleNamespace(
            content_length=int(length) if length is not None else None,
            last_modified=modified,
            is_directory=False)

    def get_directory_metadata(self, directory_path: str) -> SimpleNamespace:
        url = self._client.dirs_url(directory_path)
        _http_request("HEAD", url, self._client.auth()).close()
        return SimpleNamespace(is_directory=True)

    def create_directory(self, directory_path: str) -> None:
        url = self._client.dirs_url(directory_path)
        _http_request("PUT", url, self._client.auth()).close()

    def delete(self, file_path: str) -> None:
        url = self._client.files_url(file_path)
        _http_request("DELETE", url, self._client.auth()).close()

    def delete_directory(self, directory_path: str) -> None:
        url = self._client.dirs_url(directory_path)
        _http_request("DELETE", url, self._client.auth()).close()

    def list_directory_contents(
        self,
        directory_path: str,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> list[SimpleNamespace]:
        url = self._client.dirs_url(directory_path)
        response = _http_request("GET", url, self._client.auth())
        payload = json.loads(response.read())
        response.close()
        return [
            SimpleNamespace(path=entry["path"],
                            name=entry.get("name"),
                            file_size=entry.get("file_size"),
                            is_directory=entry.get("is_directory", False),
                            last_modified=entry.get("last_modified"))
            for entry in payload.get("contents", [])
        ]


class _HttpApiClient:

    def __init__(self, client: "HttpFilesClient") -> None:
        self._client = client
        self._cfg = SimpleNamespace(workspace_id=None)

    def do(
        self,
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        response_headers: list[str] | None = None,
        raw: bool = False,
    ) -> dict[str, bytes]:
        url = self._client.host + path
        response = _http_request(method, url, self._client.auth(headers))
        data = response.read()
        response.close()
        return {"contents": data}


class HttpFilesClient:

    def __init__(self, host: str, token: str) -> None:
        self.host = host.rstrip("/")
        self.token = token
        self.files = _HttpFiles(self)
        self.api_client = _HttpApiClient(self)

    def auth(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}"}
        if extra:
            headers.update(extra)
        return headers

    def files_url(self,
                  remote_path: str,
                  query: dict[str, str] | None = None) -> str:
        url = f"{self.host}/api/2.0/fs/files{quote(remote_path)}"
        if query:
            url += "?" + urlencode(query)
        return url

    def dirs_url(self,
                 remote_path: str,
                 query: dict[str, str] | None = None) -> str:
        url = f"{self.host}/api/2.0/fs/directories{quote(remote_path)}"
        if query:
            url += "?" + urlencode(query)
        return url
