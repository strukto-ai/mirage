import pytest
from aioresponses import CallbackResult, aioresponses

import mirage.core.msgraph.drive as drive_ops
from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.types import WriteReceipt
from mirage.core.onedrive.write import write_bytes
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.settle import Settled, settling


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"
_CONTENT = _BASE + "/root:/Docs/a.txt:/content"
_SESSION = _BASE + "/root:/Docs/a.txt:/createUploadSession"


@pytest.mark.asyncio
async def test_write_small_file_puts_content():
    captured = {}

    def _cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=201, payload={"id": "X", "name": "a.txt"})

    with aioresponses() as m:
        m.put(_CONTENT, callback=_cb)
        result = await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"hello"
        )
    assert result is None
    assert captured["body"] == b"hello"


@pytest.mark.asyncio
async def test_write_large_file_uses_upload_session(monkeypatch):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 4)
    ranges = []

    def _chunk_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(status=202, payload={})

    def _final_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(status=201, payload={"id": "X"})

    upload_url = "https://upload.example/session1"
    with aioresponses() as m:
        m.post(_SESSION, payload={"uploadUrl": upload_url})
        m.put(upload_url, callback=_chunk_cb)
        m.put(upload_url, callback=_final_cb)
        await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"abcdef"
        )
    assert ranges == ["bytes 0-3/6", "bytes 4-5/6"]


@pytest.mark.asyncio
async def test_upload_session_requests_replace(monkeypatch):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 8)
    captured = {}

    def _session_cb(url, **kwargs):
        captured.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"uploadUrl": upload_url})

    upload_url = "https://upload.example/session3"
    with aioresponses() as m:
        m.post(_SESSION, callback=_session_cb)
        m.put(upload_url, status=201, payload={"id": "X"})
        await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"abcdef"
        )
    behavior = captured["item"]["@microsoft.graph.conflictBehavior"]
    assert behavior == "replace"


@pytest.mark.asyncio
async def test_upload_resumes_from_next_expected_ranges(monkeypatch):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 4)
    ranges = []

    def _chunk_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(
            status=202, payload={"nextExpectedRanges": ["2-5"]}
        )

    def _final_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(status=201, payload={"id": "X"})

    upload_url = "https://upload.example/session2"
    with aioresponses() as m:
        m.post(_SESSION, payload={"uploadUrl": upload_url})
        m.put(upload_url, callback=_chunk_cb)
        m.put(upload_url, callback=_final_cb)
        await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"abcdef"
        )
    assert ranges == ["bytes 0-3/6", "bytes 2-5/6"]


@pytest.mark.asyncio
async def test_write_records_the_virtual_path():
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        with aioresponses() as m:
            m.put(
                _BASE + "/root:/m/k.txt:/content",
                status=201,
                payload={"id": "X"},
            )
            await write_bytes(_accessor(), spec, b"hello")
    finally:
        scope.close()
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply,receipt",
    [
        ({"id": "X", "size": 7, "cTag": "c2"}, WriteReceipt(7, "c2")),
        ({"id": "X"}, WriteReceipt(None, None)),
    ],
)
async def test_write_settles_with_the_upload_reply(reply, receipt):
    # The PUT answers the stored item: its size and cTag are what the
    # drive holds, which property promotion can make differ from the body.
    with settling() as manager, aioresponses() as m:
        m.put(_CONTENT, status=201, payload=reply)
        await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"hello"
        )
    assert manager.settled == [Settled("/Docs/a.txt", b"hello", receipt, 5)]
    assert manager.writes == []


@pytest.mark.asyncio
async def test_a_session_upload_settles_with_the_final_chunk_reply(
    monkeypatch,
):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 4)
    upload_url = "https://upload.example/session4"
    with settling() as manager, aioresponses() as m:
        m.post(_SESSION, payload={"uploadUrl": upload_url})
        m.put(upload_url, status=202, payload={"nextExpectedRanges": ["4-"]})
        m.put(
            upload_url,
            status=201,
            payload={"id": "X", "size": 9, "cTag": "c3"},
        )
        await write_bytes(
            _accessor(), PathSpec.from_str_path("/Docs/a.txt"), b"abcdef"
        )
    assert manager.settled == [
        Settled("/Docs/a.txt", b"abcdef", WriteReceipt(9, "c3"), 5)
    ]
