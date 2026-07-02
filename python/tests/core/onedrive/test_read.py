import re

import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.read import read_bytes
from mirage.observe.context import (RecordingScope, push_revisions,
                                    reset_revisions)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"
_CONTENT = _BASE + "/root:/Docs/a.txt:/content"


@pytest.mark.asyncio
async def test_read_returns_current_content():
    with aioresponses() as m:
        m.get(_CONTENT, body=b"current bytes")
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"))
    assert data == b"current bytes"


@pytest.mark.asyncio
async def test_read_pinned_revision_hits_version_content():
    version_url = _BASE + "/root:/Docs/a.txt:/versions/3.0/content"
    token = push_revisions({"/Docs/a.txt": "3.0"})
    try:
        with aioresponses() as m:
            m.get(version_url, body=b"old version bytes")
            data = await read_bytes(_accessor(),
                                    PathSpec.from_str_path("/Docs/a.txt"))
    finally:
        reset_revisions(token)
    assert data == b"old version bytes"


@pytest.mark.asyncio
async def test_read_range_sends_range_header():
    captured = {}

    def _cb(url, **kwargs):
        captured["range"] = kwargs["headers"].get("Range")
        return CallbackResult(body=b"llo")

    with aioresponses() as m:
        m.get(_CONTENT, callback=_cb)
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"),
                                offset=2,
                                size=3)
    assert captured["range"] == "bytes=2-4"
    assert data == b"llo"


_META = re.compile(r".*/root:/Docs/a\.txt(\?.*)?$")
_DOWNLOAD = "https://download.example/pinned-bytes"


def _meta_payload():
    return {
        "id":
        "01",
        "cTag":
        "ctag-xyz",
        "@microsoft.graph.downloadUrl":
        _DOWNLOAD,
        "versions": [
            {
                "id": "1.0",
                "lastModifiedDateTime": "2026-01-01T00:00:00Z"
            },
            {
                "id": "2.0",
                "lastModifiedDateTime": "2026-02-01T00:00:00Z"
            },
        ],
    }


@pytest.mark.asyncio
async def test_read_captures_fingerprint_and_revision_when_recording():
    scope = RecordingScope()
    sink = scope.records
    try:
        with aioresponses() as m:
            m.get(_META, payload=_meta_payload())
            m.get(_DOWNLOAD, body=b"old version bytes")
            data = await read_bytes(_accessor(),
                                    PathSpec.from_str_path("/Docs/a.txt"))
    finally:
        scope.close()
    rec = sink[0]
    assert rec.fingerprint == "ctag-xyz"
    assert rec.revision == "2.0"
    assert data == b"old version bytes"


@pytest.mark.asyncio
async def test_capture_reads_pinned_download_url_not_live_content():
    scope = RecordingScope()
    sink = scope.records
    try:
        with aioresponses() as m:
            m.get(_META, payload=_meta_payload())
            m.get(_DOWNLOAD, body=b"snapshot bytes")
            m.get(_CONTENT, body=b"live mutated bytes")
            data = await read_bytes(_accessor(),
                                    PathSpec.from_str_path("/Docs/a.txt"))
    finally:
        scope.close()
    assert data == b"snapshot bytes"
    assert sink[0].fingerprint == "ctag-xyz"


@pytest.mark.asyncio
async def test_read_missing_raises_file_not_found():
    with aioresponses() as m:
        m.get(_CONTENT,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        with pytest.raises(FileNotFoundError) as exc:
            await read_bytes(
                _accessor(),
                PathSpec.from_str_path("/od/Docs/a.txt",
                                       mount_key("/od/Docs/a.txt", "/od")))
    assert str(exc.value) == "/od/Docs/a.txt"
