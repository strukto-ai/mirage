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
from collections.abc import Mapping
from unittest.mock import AsyncMock, patch

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.dropbox.client import (
    DropboxApiError,
    DropboxTokenManager,
    _token_url_of,
    dropbox_download,
    dropbox_download_stream,
    dropbox_upload,
    summary_of,
)
from mirage.core.dropbox.constants import (
    DROPBOX_API_BASE,
    DROPBOX_CONTENT_BASE,
)
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig


def make_config(**overrides) -> DropboxConfig:
    return DropboxConfig(
        client_id="c", client_secret="s", refresh_token="r", **overrides
    )


def test_default_bases_are_production_hosts():
    tm = DropboxTokenManager(make_config())
    assert tm.api_base == DROPBOX_API_BASE
    assert tm.content_base == DROPBOX_CONTENT_BASE


def test_endpoint_override_serves_api_and_content_from_one_origin():
    tm = DropboxTokenManager(make_config(endpoint="http://127.0.0.1:9999/"))
    assert tm.api_base == "http://127.0.0.1:9999/2"
    assert tm.content_base == "http://127.0.0.1:9999/2"
    assert (
        _token_url_of(make_config(endpoint="http://127.0.0.1:9999/"))
        == "http://127.0.0.1:9999/oauth2/token"
    )


def test_token_url_defaults_to_production():
    assert (
        _token_url_of(make_config())
        == "https://api.dropboxapi.com/oauth2/token"
    )


@pytest.mark.asyncio
async def test_get_token_caches_until_expiry():
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.refresh_access_token",
        new_callable=AsyncMock,
        return_value=("tok", 14400),
    ) as refresh:
        assert await tm.get_token() == "tok"
        assert await tm.get_token() == "tok"
    assert refresh.await_count == 1


DOWNLOAD_URL = f"{DROPBOX_CONTENT_BASE}/files/download"


async def _download(
    status: int,
    body: bytes,
    window: ByteWindow | None,
    headers: dict[str, str] | None = None,
) -> tuple[bytes, str | None, dict]:
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.dropbox_auth_headers",
        new_callable=AsyncMock,
        return_value={},
    ):
        with aioresponses() as m:
            m.post(DOWNLOAD_URL, status=status, body=body, headers=headers)
            data, result = await dropbox_download(tm, "/a.txt", window)
            sent = m.requests[("POST", URL(DOWNLOAD_URL))][0].kwargs
    return data, result, sent


@pytest.mark.asyncio
async def test_a_window_is_sent_as_a_range_header():
    _, _, sent = await _download(206, b"234", ByteWindow(2, 3))

    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _, _ = await _download(206, b"234", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_server_ignored_the_range():
    """RFC 9110 lets a server answer a Range request with the whole
    representation. Before this was handled the caller got every byte for
    what it asked to be a window."""
    data, _, _ = await _download(200, b"0123456789", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, _, sent = await _download(200, b"0123456789", None)

    assert data == b"0123456789"
    assert "Range" not in sent["headers"]


RESULT = json.dumps({"name": "a.txt", "content_hash": "abc123"})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, window, headers, result",
    [
        (200, None, {"Dropbox-API-Result": RESULT}, RESULT),
        (206, ByteWindow(2, 3), {"Dropbox-API-Result": RESULT}, RESULT),
        (200, None, None, None),
    ],
    ids=["whole", "ranged", "absent"],
)
async def test_a_download_hands_back_its_result_header(
    status, window, headers, result
):
    _, handed, _ = await _download(status, b"234", window, headers)

    assert handed == result


@pytest.mark.asyncio
async def test_a_stream_hands_its_headers_before_the_first_chunk():
    # A plain lower-cased map, as bytes_response hands its own, so a
    # consumer that stops early still leaves the read stamped.
    events: list[Mapping[str, str] | bytes] = []
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.dropbox_auth_headers",
        new_callable=AsyncMock,
        return_value={},
    ):
        with aioresponses() as m:
            m.post(
                DOWNLOAD_URL,
                status=200,
                body=b"hello",
                headers={"Dropbox-API-Result": RESULT},
            )
            async for chunk in dropbox_download_stream(
                tm, "/a.txt", on_response=events.append
            ):
                events.append(chunk)
        await tm.pool.close()
    assert type(events[0]) is dict
    assert events[0]["dropbox-api-result"] == RESULT
    assert events[1:] == [b"hello"]


@pytest.mark.parametrize(
    "text",
    ["null", '{"error_summary": 5}', '["path/not_found/.."]', "oops"],
    ids=["null", "number", "not-object", "not-json"],
)
def test_a_body_without_a_string_summary_is_empty(text):
    assert summary_of(text) == ""


UPLOAD_URL = f"{DROPBOX_CONTENT_BASE}/files/upload"


async def _upload(body: bytes, content_type: str):
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.dropbox_auth_headers",
        new_callable=AsyncMock,
        return_value={},
    ):
        with aioresponses() as m:
            m.post(
                UPLOAD_URL,
                status=200,
                body=body,
                headers={"Content-Type": content_type},
            )
            return await dropbox_upload(tm, "/a.txt", b"hello")


@pytest.mark.asyncio
async def test_an_upload_hands_back_the_stored_file_metadata():
    entry = {".tag": "file", "name": "a.txt", "size": 5, "content_hash": "h5"}
    got = await _upload(json.dumps(entry).encode(), "application/json")
    assert got == entry


@pytest.mark.asyncio
async def test_an_upload_with_a_non_json_body_hands_it_back_unchecked():
    # The upload has landed; an unreadable reply must not raise. The
    # writer's upload_token reads it as no metadata.
    assert await _upload(b"not json", "text/plain") == "not json"


MIB = 1024 * 1024


# Dropbox's files/upload takes up to 150 MB (its API docs, not probed);
# past 8 MiB an upload takes a session whatever holds the bytes.
@pytest.mark.asyncio
@pytest.mark.parametrize("spooled", [False, True], ids=["bytes", "spool"])
@pytest.mark.parametrize("size", [8 * MIB, 8 * MIB + 1])
async def test_a_dropbox_upload_takes_a_session_only_past_8_mib(spooled, size):
    tm = DropboxTokenManager(make_config())
    tm.seed("tok", float("inf"))
    base = f"{tm.content_base}/files/upload_session"
    payload = b"x" * size
    async with ByteSpool() as spool:
        await spool.append(payload)
        with aioresponses() as m:
            m.post(UPLOAD_URL, payload={"name": "file"})
            m.post(f"{base}/start", payload={"session_id": "s"})
            m.post(f"{base}/append_v2", payload=None, repeat=True)
            m.post(f"{base}/finish", payload={"name": "file"})
            got = await dropbox_upload(
                tm, "/file", spool if spooled else payload
            )
            assert got == {"name": "file"}
            assert {
                str(url): len(calls) for (_, url), calls in m.requests.items()
            } == (
                {UPLOAD_URL: 1}
                if size <= 8 * MIB
                else {
                    f"{base}/start": 1,
                    f"{base}/append_v2": 2,
                    f"{base}/finish": 1,
                }
            )
            if size <= 8 * MIB:
                assert (
                    m.requests[("POST", URL(UPLOAD_URL))][0].kwargs["data"]
                    == payload
                )
    await tm.close()


@pytest.mark.asyncio
async def test_a_session_upload_with_a_non_json_finish_hands_it_back():
    # As with files/upload, the file has landed; the reply must not raise.
    tm = DropboxTokenManager(make_config())
    tm.seed("tok", float("inf"))
    base = f"{tm.content_base}/files/upload_session"
    with aioresponses() as m:
        m.post(f"{base}/start", payload={"session_id": "s"})
        m.post(f"{base}/append_v2", payload=None, repeat=True)
        m.post(
            f"{base}/finish",
            body=b"not json",
            headers={"Content-Type": "text/plain"},
        )
        got = await dropbox_upload(tm, "/file", b"x" * (8 * MIB + 1))
    assert got == "not json"
    await tm.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fail", "spooled"),
    [(False, True), (False, False), (True, True)],
    ids=["spool", "bytes", "conflict"],
)
async def test_upload_session_chunks_and_conditional_commit(fail, spooled):
    tm = DropboxTokenManager(make_config())
    tm.seed("tok", float("inf"))
    base = f"{tm.content_base}/files/upload_session"
    # A distinct tail, so a window read from the wrong offset differs.
    payload = b"x" * (8 * MIB) + b"abcdefg"
    async with ByteSpool() as spool:
        await spool.append(payload)
        data = spool if spooled else payload
        with (
            aioresponses() as m,
            patch.object(spool, "read", wraps=spool.read) as read,
        ):
            m.post(base + "/start", payload={"session_id": "session"})
            m.post(base + "/append_v2", payload=None, repeat=True)
            m.post(
                base + "/finish",
                status=409 if fail else 200,
                payload={"error_summary": "path/conflict"}
                if fail
                else {"name": "file"},
            )
            if fail:
                with pytest.raises(DropboxApiError):
                    await dropbox_upload(tm, "/file", data, "rev1")
            else:
                assert await dropbox_upload(tm, "/file", data, "rev1") == {
                    "name": "file"
                }
            appends = m.requests[("POST", URL(base + "/append_v2"))]
            bodies = [c.kwargs["data"] for c in appends]
            assert b"".join(bodies) == payload
            assert [len(body) for body in bodies] == [8 * MIB, 7]
            assert [
                json.loads(c.kwargs["headers"]["Dropbox-API-Arg"])["cursor"][
                    "offset"
                ]
                for c in appends
            ] == [0, 8 * MIB]
            finish = m.requests[("POST", URL(base + "/finish"))][0].kwargs
            arg = json.loads(finish["headers"]["Dropbox-API-Arg"])
            assert arg["cursor"]["offset"] == len(payload)
            # One window per read: the spool is never loaded whole.
            assert all(c.args[1] <= 8 * MIB for c in read.await_args_list)
            assert arg["commit"]["mode"] == {
                ".tag": "update",
                "update": "rev1",
            }
            assert len(appends) == 2
    await tm.close()
