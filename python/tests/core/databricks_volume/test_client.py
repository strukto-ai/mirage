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

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.databricks_volume.client import HttpDatabricksFilesClient
from mirage.core.databricks_volume.errors import (DatabricksVolumeApiError,
                                                  is_not_found)
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               StaticTokenProvider)
from mirage.utils.ranges import ByteWindow

HOST = "https://dbc.example.com"
ROOT = "/Volumes/main/default/agent_files"
FILES_URL = f"{HOST}/api/2.0/fs/files{ROOT}/a.txt"
DIRS_URL = f"{HOST}/api/2.0/fs/directories{ROOT}"


class RotatingTokenProvider:

    def __init__(self, tokens: list[str]) -> None:
        self.tokens = list(tokens)
        self.calls = 0

    def get_token(self) -> str:
        token = self.tokens[min(self.calls, len(self.tokens) - 1)]
        self.calls += 1
        return token


class AsyncTokenProvider:

    def __init__(self, token: str) -> None:
        self.token = token
        self.calls = 0

    async def get_token(self) -> str:
        self.calls += 1
        return self.token


def make_config(**overrides) -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(host=HOST,
                                  catalog="main",
                                  schema="default",
                                  volume="agent_files",
                                  **overrides)


def make_client(provider=None) -> HttpDatabricksFilesClient:
    return HttpDatabricksFilesClient(
        make_config(), provider or StaticTokenProvider("tok-123"))


def sent(m: aioresponses, method: str, url: str) -> list:
    return m.requests[(method, URL(url))]


def test_url_escapes_each_segment_and_keeps_separators():
    client = make_client()
    assert client.url("files", f"{ROOT}/my report #1.txt") == (
        f"{HOST}/api/2.0/fs/files{ROOT}/my%20report%20%231.txt")


def test_url_uses_the_directories_endpoint_for_directories():
    client = make_client()
    assert client.url("directories", ROOT) == DIRS_URL


@pytest.mark.asyncio
async def test_download_sends_the_bearer_token():
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"hello")
        assert await make_client().download(f"{ROOT}/a.txt") == b"hello"
        kwargs = sent(m, "GET", FILES_URL)[0].kwargs
    assert kwargs["headers"]["Authorization"] == "Bearer tok-123"
    assert kwargs["headers"]["Accept"] == "application/octet-stream"


@pytest.mark.asyncio
async def test_download_window_sends_a_range_header():
    with aioresponses() as m:
        m.get(FILES_URL, status=206, body=b"234")
        data = await make_client().download(f"{ROOT}/a.txt", ByteWindow(2, 3))
        kwargs = sent(m, "GET", FILES_URL)[0].kwargs
    assert data == b"234"
    assert kwargs["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_200_answer_to_a_range_request_is_trimmed():
    """RFC 9110 lets a server answer a Range with the whole object, and
    a gateway in front of the Files API may. Trusting the body would
    hand the caller every byte for what it asked to be a window."""
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"0123456789")
        data = await make_client().download(f"{ROOT}/a.txt", ByteWindow(2, 3))
    assert data == b"234"


@pytest.mark.asyncio
async def test_download_without_a_window_sends_no_range():
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"0123456789")
        data = await make_client().download(f"{ROOT}/a.txt")
        kwargs = sent(m, "GET", FILES_URL)[0].kwargs
    assert data == b"0123456789"
    assert "Range" not in kwargs["headers"]


@pytest.mark.asyncio
async def test_download_stream_yields_the_whole_body_in_chunks():
    """The streaming read is the one method that owns its session
    instead of going through the shared kit, so the bearer header and
    the chunk loop are only covered here."""
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"0123456789")
        chunks = [
            chunk async for chunk in make_client().download_stream(
                f"{ROOT}/a.txt", 4)
        ]
        kwargs = sent(m, "GET", FILES_URL)[0].kwargs
    assert b"".join(chunks) == b"0123456789"
    assert all(len(chunk) <= 4 for chunk in chunks)
    assert kwargs["headers"]["Authorization"] == "Bearer tok-123"
    assert kwargs["headers"]["Accept"] == "application/octet-stream"


@pytest.mark.asyncio
async def test_download_stream_maps_a_404_to_the_backend_error():
    body = json.dumps({
        "error_code": "RESOURCE_DOES_NOT_EXIST",
        "message": "The file being accessed is not found",
    })
    with aioresponses() as m:
        m.get(FILES_URL, status=404, body=body)
        with pytest.raises(DatabricksVolumeApiError) as excinfo:
            async for _ in make_client().download_stream(f"{ROOT}/a.txt", 4):
                pass
    error = excinfo.value
    assert error.status_code == 404
    assert error.error_code == "RESOURCE_DOES_NOT_EXIST"
    assert is_not_found(error)


@pytest.mark.asyncio
async def test_get_metadata_reads_the_head_headers():
    with aioresponses() as m:
        m.head(FILES_URL,
               status=200,
               headers={
                   "Content-Length": "6",
                   "Content-Type": "text/plain",
                   "Last-Modified": "Tue, 14 Nov 2023 22:13:20 GMT",
               })
        meta = await make_client().get_metadata(f"{ROOT}/a.txt")
    assert meta.content_length == 6
    assert meta.content_type == "text/plain"
    assert meta.last_modified == "Tue, 14 Nov 2023 22:13:20 GMT"


@pytest.mark.asyncio
async def test_list_directory_concatenates_pages():
    page_one = {
        "contents": [{
            "path": f"{ROOT}/a.txt",
            "is_directory": False,
            "file_size": 3,
            "last_modified": 1_700_000_000_000,
        }],
        "next_page_token":
        "p2",
    }
    page_two = {
        "contents": [{
            "path": f"{ROOT}/sub",
            "is_directory": True,
        }],
    }
    with aioresponses() as m:
        m.get(DIRS_URL, status=200, payload=page_one)
        m.get(f"{DIRS_URL}?page_token=p2", status=200, payload=page_two)
        entries = await make_client().list_directory(ROOT)
    paths = [entry.path for entry in entries]
    assert paths == [f"{ROOT}/a.txt", f"{ROOT}/sub"]
    assert entries[0].file_size == 3
    assert entries[0].last_modified == 1_700_000_000_000
    assert entries[1].is_directory is True
    assert entries[1].file_size is None


@pytest.mark.asyncio
async def test_upload_overwrites_and_sends_raw_bytes():
    url = f"{FILES_URL}?overwrite=true"
    with aioresponses() as m:
        m.put(url, status=204)
        await make_client().upload(f"{ROOT}/a.txt", b"hello")
        kwargs = sent(m, "PUT", url)[0].kwargs
    assert kwargs["data"] == b"hello"
    assert kwargs["params"] == {"overwrite": "true"}
    assert kwargs["headers"]["Content-Type"] == "application/octet-stream"


@pytest.mark.asyncio
async def test_create_and_delete_directory_hit_the_directories_endpoint():
    with aioresponses() as m:
        m.put(DIRS_URL, status=204)
        m.delete(DIRS_URL, status=204)
        client = make_client()
        await client.create_directory(ROOT)
        await client.delete_directory(ROOT)
        assert len(sent(m, "PUT", DIRS_URL)) == 1
        assert len(sent(m, "DELETE", DIRS_URL)) == 1


@pytest.mark.asyncio
async def test_a_404_body_becomes_a_not_found_error():
    body = json.dumps({
        "error_code": "RESOURCE_DOES_NOT_EXIST",
        "message": "The file being accessed is not found",
    })
    with aioresponses() as m:
        m.get(FILES_URL, status=404, body=body)
        with pytest.raises(DatabricksVolumeApiError) as excinfo:
            await make_client().download(f"{ROOT}/a.txt")
    error = excinfo.value
    assert error.status_code == 404
    assert error.error_code == "RESOURCE_DOES_NOT_EXIST"
    assert is_not_found(error)
    assert "The file being accessed is not found" in str(error)


@pytest.mark.asyncio
async def test_a_head_404_carries_no_body_and_still_reads_as_not_found():
    with aioresponses() as m:
        m.head(FILES_URL, status=404)
        with pytest.raises(DatabricksVolumeApiError) as excinfo:
            await make_client().get_metadata(f"{ROOT}/a.txt")
    assert excinfo.value.status_code == 404
    assert is_not_found(excinfo.value)


@pytest.mark.asyncio
async def test_a_401_propagates_without_a_replay():
    """An on-behalf-of provider cannot re-mint a user's token and a
    write must not be sent twice, so a refused call is reported rather
    than retried."""
    with aioresponses() as m:
        m.put(f"{FILES_URL}?overwrite=true", status=401, body="{}")
        with pytest.raises(DatabricksVolumeApiError) as excinfo:
            await make_client().upload(f"{ROOT}/a.txt", b"hello")
        assert len(sent(m, "PUT", f"{FILES_URL}?overwrite=true")) == 1
    assert excinfo.value.status_code == 401


@pytest.mark.asyncio
async def test_a_429_is_retried_then_succeeds():
    with aioresponses() as m:
        m.get(FILES_URL, status=429, body="{}", headers={"Retry-After": "0"})
        m.get(FILES_URL, status=200, body=b"hello")
        assert await make_client().download(f"{ROOT}/a.txt") == b"hello"
        assert len(sent(m, "GET", FILES_URL)) == 2


@pytest.mark.asyncio
async def test_an_async_provider_is_awaited():
    provider = AsyncTokenProvider("tok-async")
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"hello")
        await make_client(provider).download(f"{ROOT}/a.txt")
        kwargs = sent(m, "GET", FILES_URL)[0].kwargs
    assert provider.calls == 1
    assert kwargs["headers"]["Authorization"] == "Bearer tok-async"


@pytest.mark.asyncio
async def test_each_operation_consults_the_provider_again():
    provider = RotatingTokenProvider(["tok-one", "tok-two"])
    client = make_client(provider)
    with aioresponses() as m:
        m.get(FILES_URL, status=200, body=b"a")
        m.get(FILES_URL, status=200, body=b"b")
        await client.download(f"{ROOT}/a.txt")
        await client.download(f"{ROOT}/a.txt")
        calls = sent(m, "GET", FILES_URL)
    assert provider.calls == 2
    assert calls[0].kwargs["headers"]["Authorization"] == "Bearer tok-one"
    assert calls[1].kwargs["headers"]["Authorization"] == "Bearer tok-two"


@pytest.mark.asyncio
async def test_an_empty_token_is_refused_before_any_request():
    client = make_client(StaticTokenProvider(""))
    with aioresponses() as m:
        with pytest.raises(ValueError, match="empty token"):
            await client.download(f"{ROOT}/a.txt")
        assert m.requests == {}
