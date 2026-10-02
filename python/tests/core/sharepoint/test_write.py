import pytest
from aioresponses import CallbackResult, aioresponses

import mirage.core.msgraph.drive as drive_ops
from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.types import WriteReceipt
from mirage.core.sharepoint.write import write_bytes
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.settle import Settled, settling

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


@pytest.mark.asyncio
async def test_write_small_file():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt:/content"
    captured = {}

    def _cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=201, payload={"id": "X", "name": "a.txt"})

    with aioresponses() as m:
        m.put(url, callback=_cb)
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents/a.txt", "/sp"),
            virtual="/sp/Engineering/Documents/a.txt",
            directory="/sp/Engineering/Documents/a.txt",
        )
        await write_bytes(_accessor(), path, b"hello")
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

    session_url = (
        f"{_BASE}/drives/{_DRIVE_ID}/root:/big.bin:/createUploadSession"
    )
    upload_url = "https://upload.example/session1"
    with aioresponses() as m:
        m.post(session_url, payload={"uploadUrl": upload_url})
        m.put(upload_url, callback=_chunk_cb)
        m.put(upload_url, callback=_final_cb)
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents/big.bin", "/sp"),
            virtual="/sp/Engineering/Documents/big.bin",
            directory="/sp/Engineering/Documents/big.bin",
        )
        await write_bytes(_accessor(), path, b"abcdef")
    assert ranges == ["bytes 0-3/6", "bytes 4-5/6"]


@pytest.mark.asyncio
async def test_upload_session_requests_replace(monkeypatch):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 8)
    captured = {}

    def _session_cb(url, **kwargs):
        captured.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"uploadUrl": upload_url})

    session_url = (
        f"{_BASE}/drives/{_DRIVE_ID}/root:/big.bin:/createUploadSession"
    )
    upload_url = "https://upload.example/session2"
    with aioresponses() as m:
        m.post(session_url, callback=_session_cb)
        m.put(upload_url, status=201, payload={"id": "X"})
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents/big.bin", "/sp"),
            virtual="/sp/Engineering/Documents/big.bin",
            directory="/sp/Engineering/Documents/big.bin",
        )
        await write_bytes(_accessor(), path, b"abcdef")
    behavior = captured["item"]["@microsoft.graph.conflictBehavior"]
    assert behavior == "replace"


@pytest.mark.asyncio
async def test_write_records_the_virtual_path():
    # The site is named like its mount, so m/Documents/k.txt is not virtual.
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["m"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    spec = PathSpec(
        virtual="/m/m/Documents/k.txt",
        directory="/m/m/Documents/",
        vfs_path="m/Documents/k.txt",
    )
    scope = RecordingScope()
    try:
        with aioresponses() as m:
            m.put(
                f"{_BASE}/drives/{_DRIVE_ID}/root:/k.txt:/content",
                status=201,
                payload={"id": "X"},
            )
            await write_bytes(accessor, spec, b"hello")
    finally:
        scope.close()
    assert [r.path for r in scope.records] == ["/m/m/Documents/k.txt"]


def _sp_path(name: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(f"/sp/Engineering/Documents/{name}", "/sp"),
        virtual=f"/sp/Engineering/Documents/{name}",
        directory=f"/sp/Engineering/Documents/{name}",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply,receipt",
    [
        ({"id": "X", "size": 13, "cTag": "c2"}, WriteReceipt(13, "c2")),
        ({"id": "X"}, WriteReceipt(None, None)),
    ],
)
async def test_write_settles_with_the_upload_reply(reply, receipt):
    # Property promotion rewrites an uploaded Office file: the reply's
    # size is what the library stored, not the length of the body.
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/a.docx:/content"
    with settling() as manager, aioresponses() as m:
        m.put(url, status=201, payload=reply)
        await write_bytes(_accessor(), _sp_path("a.docx"), b"hello")
    assert manager.settled == [
        Settled("/sp/Engineering/Documents/a.docx", b"hello", receipt, 5)
    ]
    assert manager.writes == []


@pytest.mark.asyncio
async def test_a_session_upload_settles_with_the_final_chunk_reply(
    monkeypatch,
):
    monkeypatch.setattr(drive_ops, "SIMPLE_UPLOAD_MAX", 4)
    monkeypatch.setattr(drive_ops, "UPLOAD_CHUNK", 4)
    session_url = (
        f"{_BASE}/drives/{_DRIVE_ID}/root:/big.bin:/createUploadSession"
    )
    upload_url = "https://upload.example/session5"
    with settling() as manager, aioresponses() as m:
        m.post(session_url, payload={"uploadUrl": upload_url})
        m.put(upload_url, status=202, payload={"nextExpectedRanges": ["4-"]})
        m.put(
            upload_url,
            status=201,
            payload={"id": "X", "size": 9, "cTag": "c3"},
        )
        await write_bytes(_accessor(), _sp_path("big.bin"), b"abcdef")
    assert manager.settled == [
        Settled(
            "/sp/Engineering/Documents/big.bin",
            b"abcdef",
            WriteReceipt(9, "c3"),
            5,
        )
    ]
