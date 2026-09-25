import re

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

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
_ITEM = _BASE + "/root:/Docs/a.txt"
_BYTES = "https://download.example/a.txt"


def _item(download: str | None = _BYTES) -> dict:
    item = {"id": "01", "cTag": "ctag-xyz", "eTag": "etag-xyz"}
    if download is not None:
        item["@microsoft.graph.downloadUrl"] = download
    return item


def _calls(m: aioresponses, url: str) -> int:
    return len(m.requests.get(("GET", URL(url)), []))


@pytest.mark.asyncio
async def test_read_returns_current_content():
    with aioresponses() as m:
        m.get(_ITEM, payload=_item())
        m.get(_BYTES, body=b"current bytes")
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"))
        assert (_calls(m, _ITEM), _calls(m, _BYTES)) == (1, 1)
    assert data == b"current bytes"


@pytest.mark.asyncio
async def test_an_unrecorded_read_fetches_the_item_then_its_download_url():
    seen: list[tuple[str, str | None]] = []

    def item(url, **kwargs):
        seen.append(("item", kwargs["headers"].get("Authorization")))
        return CallbackResult(payload=_item())

    def download(url, **kwargs):
        seen.append(("download", kwargs["headers"].get("Authorization")))
        return CallbackResult(body=b"current bytes")

    with aioresponses() as m:
        m.get(_ITEM, callback=item)
        m.get(_BYTES, callback=download)
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"))
    assert data == b"current bytes"
    # The token comes first, so a write between the two requests can only
    # make the cached bytes look stale. The download URL is pre-signed and
    # must not carry the mount's bearer token.
    assert seen == [("item", "Bearer tok"), ("download", None)]


@pytest.mark.asyncio
async def test_a_read_falls_back_to_content_when_graph_omits_the_download_url(
):
    seen: list[str | None] = []

    def content(url, **kwargs):
        seen.append(kwargs["headers"].get("Authorization"))
        return CallbackResult(body=b"current bytes")

    with aioresponses() as m:
        m.get(_ITEM, payload=_item(download=None))
        m.get(_CONTENT, callback=content)
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"))
        assert _calls(m, _ITEM) == 1
    assert data == b"current bytes"
    assert seen == ["Bearer tok"]


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
        return CallbackResult(body=b"llo", status=206)

    with aioresponses() as m:
        m.get(_ITEM, payload=_item())
        m.get(_BYTES, callback=_cb)
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"),
                                offset=2,
                                size=3)
    assert captured["range"] == "bytes=2-4"
    assert data == b"llo"


@pytest.mark.asyncio
async def test_a_200_answer_to_a_range_request_is_sliced_locally():
    """Graph redirects content downloads to a pre-authenticated URL,
    which may answer 200 with the whole item. Before this was handled
    the caller got every byte for what it asked to be a window."""
    with aioresponses() as m:
        m.get(_ITEM, payload=_item())
        m.get(_BYTES, body=b"hello", status=200)
        data = await read_bytes(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"),
                                offset=2,
                                size=3)
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
        m.get(_ITEM,
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


_MM_META = re.compile(r".*/root:/m/k\.txt(\?.*)?$")
_MM_CONTENT = _BASE + "/root:/m/k.txt:/content"
_MM_SPEC = PathSpec(virtual="/m/m/k.txt",
                    directory="/m/m/",
                    vfs_path="m/k.txt")


@pytest.mark.asyncio
async def test_recorded_read_names_the_virtual_path():
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    scope = RecordingScope()
    try:
        with aioresponses() as m:
            m.get(_MM_META, payload={"id": "01", "cTag": "c1", "versions": []})
            m.get(_MM_CONTENT, body=b"bytes")
            data = await read_bytes(_accessor(), _MM_SPEC)
    finally:
        scope.close()
    assert data == b"bytes"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
