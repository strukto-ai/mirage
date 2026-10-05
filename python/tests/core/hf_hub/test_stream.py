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

from unittest.mock import patch

import pytest

from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.stream import read_stream
from mirage.observe.context import RecordingScope
from tests.core.hf_hub.conftest import file_row, ps, seed


async def _chunks(*payload):
    for item in payload:
        yield item


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_read_stream_yields_every_chunk(mock_stream, loaded):
    mock_stream.return_value = _chunks(b"ab", b"cd")
    got = [c async for c in read_stream(loaded, ps("a.txt"))]
    assert got == [b"ab", b"cd"]
    assert mock_stream.call_args.args[1].endswith("/resolve/main/a.txt")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_read_stream_of_a_directory_is_eisdir(mock_stream, loaded):
    with pytest.raises(IsADirectoryError):
        [c async for c in read_stream(loaded, ps("d"))]
    mock_stream.assert_not_called()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_stream_records_the_virtual_path(mock_stream, accessor):
    # A repo folder named like its mount keeps /m/k.txt off the virtual path.
    seed(accessor, file_row("m/k.txt", 4))
    mock_stream.return_value = _chunks(b"ab", b"cd")
    scope = RecordingScope()
    try:
        got = [c async for c in read_stream(accessor, ps("m/k.txt", "/m"))]
    finally:
        scope.close()
    assert got == [b"ab", b"cd"]
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


def _answering(etag: str, *payload: bytes):
    """A hub_stream stand-in that reports its headers the way the real one
    does: once, before the first chunk."""

    async def fake(
        _token, _url, _chunk_size, *, session=None, on_response=None
    ):
        if on_response is not None:
            on_response({"etag": etag})
        for item in payload:
            yield item

    return fake


@pytest.mark.asyncio
async def test_stream_stamps_the_oid_when_the_etag_names_the_row(
    accessor, monkeypatch
):
    seed(accessor, file_row("a.txt", 4))
    monkeypatch.setattr(
        "mirage.core.hf_hub.stream.hub_stream",
        _answering('"oid-a.txt"', b"ab", b"cd"),
    )
    scope = RecordingScope()
    try:
        stream = read_stream(accessor, ps("a.txt"))
        first = await stream.__anext__()
        # Stamped as soon as the response arrived, so a reader that stops
        # after one chunk (head -c 1) still leaves a token behind.
        assert [r.fingerprint for r in scope.records] == ["oid-a.txt"]
        rest = [c async for c in stream]
    finally:
        scope.close()
    assert [first, *rest] == [b"ab", b"cd"]


@pytest.mark.asyncio
async def test_stream_stamps_nothing_when_the_bytes_are_another_version(
    accessor, monkeypatch
):
    seed(accessor, file_row("a.txt", 4))
    monkeypatch.setattr(
        "mirage.core.hf_hub.stream.hub_stream",
        _answering('"another-version"', b"newr"),
    )
    scope = RecordingScope()
    try:
        [c async for c in read_stream(accessor, ps("a.txt"))]
    finally:
        scope.close()
    assert [r.fingerprint for r in scope.records] == [None]


@pytest.mark.asyncio
async def test_stream_with_no_recorder_still_reads(accessor, monkeypatch):
    seed(accessor, file_row("a.txt", 4))
    monkeypatch.setattr(
        "mirage.core.hf_hub.stream.hub_stream",
        _answering('"oid-a.txt"', b"ab"),
    )
    assert [c async for c in read_stream(accessor, ps("a.txt"))] == [b"ab"]


def _refusing(status: int):
    async def fake(
        _token, _url, _chunk_size, *, session=None, on_response=None
    ):
        raise HfHubError("gated", status)
        yield b""

    return fake


@pytest.mark.asyncio
async def test_a_stream_the_hub_refuses_is_permission_denied(
    loaded, monkeypatch
):
    monkeypatch.setattr("mirage.core.hf_hub.stream.hub_stream", _refusing(403))
    with pytest.raises(PermissionError):
        [c async for c in read_stream(loaded, ps("a.txt"))]
