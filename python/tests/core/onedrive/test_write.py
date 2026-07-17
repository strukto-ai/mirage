import pytest
from aioresponses import CallbackResult, aioresponses

import mirage.core.msgraph.drive_ops as drive_ops
import mirage.core.onedrive.write as write_mod
from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.write import write_bytes
from mirage.types import PathSpec


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
        result = await write_bytes(_accessor(),
                                   PathSpec.from_str_path("/Docs/a.txt"),
                                   b"hello")
    assert result is None
    assert captured["body"] == b"hello"


@pytest.mark.asyncio
async def test_write_large_file_uses_upload_session(monkeypatch):
    monkeypatch.setattr(write_mod, "SIMPLE_UPLOAD_MAX", 4)
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
        await write_bytes(_accessor(), PathSpec.from_str_path("/Docs/a.txt"),
                          b"abcdef")
    assert ranges == ["bytes 0-3/6", "bytes 4-5/6"]


@pytest.mark.asyncio
async def test_upload_session_requests_replace(monkeypatch):
    monkeypatch.setattr(write_mod, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 8)
    captured = {}

    def _session_cb(url, **kwargs):
        captured.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"uploadUrl": upload_url})

    upload_url = "https://upload.example/session3"
    with aioresponses() as m:
        m.post(_SESSION, callback=_session_cb)
        m.put(upload_url, status=201, payload={"id": "X"})
        await write_bytes(_accessor(), PathSpec.from_str_path("/Docs/a.txt"),
                          b"abcdef")
    behavior = captured["item"]["@microsoft.graph.conflictBehavior"]
    assert behavior == "replace"


@pytest.mark.asyncio
async def test_upload_resumes_from_next_expected_ranges(monkeypatch):
    monkeypatch.setattr(write_mod, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 4)
    ranges = []

    def _chunk_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(status=202,
                              payload={"nextExpectedRanges": ["2-5"]})

    def _final_cb(url, **kwargs):
        ranges.append(kwargs["headers"]["Content-Range"])
        return CallbackResult(status=201, payload={"id": "X"})

    upload_url = "https://upload.example/session2"
    with aioresponses() as m:
        m.post(_SESSION, payload={"uploadUrl": upload_url})
        m.put(upload_url, callback=_chunk_cb)
        m.put(upload_url, callback=_final_cb)
        await write_bytes(_accessor(), PathSpec.from_str_path("/Docs/a.txt"),
                          b"abcdef")
    assert ranges == ["bytes 0-3/6", "bytes 2-5/6"]
