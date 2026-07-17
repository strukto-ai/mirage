import pytest
from aioresponses import CallbackResult, aioresponses

import mirage.core.msgraph.drive_ops as drive_ops
import mirage.core.sharepoint.write as write_mod
from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.write import write_bytes
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _seed_caches():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID


def _clear_caches():
    _site_cache.clear()
    _drive_cache.clear()


@pytest.fixture(autouse=True)
def _reset_caches():
    _clear_caches()
    _seed_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_write_small_file():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt:/content"
    captured = {}

    def _cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=201, payload={"id": "X", "name": "a.txt"})

    with aioresponses() as m:
        m.put(url, callback=_cb)
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/a.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/a.txt",
                        directory="/sp/Engineering/Documents/a.txt")
        await write_bytes(_accessor(), path, b"hello")
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

    session_url = (f"{_BASE}/drives/{_DRIVE_ID}"
                   "/root:/big.bin:/createUploadSession")
    upload_url = "https://upload.example/session1"
    with aioresponses() as m:
        m.post(session_url, payload={"uploadUrl": upload_url})
        m.put(upload_url, callback=_chunk_cb)
        m.put(upload_url, callback=_final_cb)
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/big.bin", "/sp"),
                        virtual="/sp/Engineering/Documents/big.bin",
                        directory="/sp/Engineering/Documents/big.bin")
        await write_bytes(_accessor(), path, b"abcdef")
    assert ranges == ["bytes 0-3/6", "bytes 4-5/6"]


@pytest.mark.asyncio
async def test_upload_session_requests_replace(monkeypatch):
    monkeypatch.setattr(write_mod, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 8)
    captured = {}

    def _session_cb(url, **kwargs):
        captured.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"uploadUrl": upload_url})

    session_url = (f"{_BASE}/drives/{_DRIVE_ID}"
                   "/root:/big.bin:/createUploadSession")
    upload_url = "https://upload.example/session2"
    with aioresponses() as m:
        m.post(session_url, callback=_session_cb)
        m.put(upload_url, status=201, payload={"id": "X"})
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/big.bin", "/sp"),
                        virtual="/sp/Engineering/Documents/big.bin",
                        directory="/sp/Engineering/Documents/big.bin")
        await write_bytes(_accessor(), path, b"abcdef")
    behavior = captured["item"]["@microsoft.graph.conflictBehavior"]
    assert behavior == "replace"
